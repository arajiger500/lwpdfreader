import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import init from '../src/wasm/lwpdf_core';
import {
  database,
  importDocument,
  getAnnotations,
  saveAnnotation,
  deleteAnnotation,
  saveProgress,
  listDocuments,
  removeDocument,
  migrateDatabase,
  getFile,
} from '../src/lib/storage';
import { validateBackup, exportBackup, importBackup } from '../src/lib/backup';
import { newAnnotation, defaultProgress, errorMessage, type DocumentMeta } from '../src/lib/types';
import { ProgressWriter } from '../src/lib/progress';
const id = 'a'.repeat(64),
  id2 = 'b'.repeat(64);
const meta = (key = id): DocumentMeta => ({
  id: key,
  name: 'Study.pdf',
  size: 5,
  pageCount: 1500,
  addedAt: 1,
  lastOpened: 1,
  available: true,
  progress: defaultProgress(),
});
beforeAll(async () => {
  await init({ module_or_path: await readFile('src/wasm/lwpdf_core_bg.wasm') });
});
beforeEach(async () => {
  const db = await database();
  for (const s of ['documents', 'files', 'annotations', 'settings', 'ink', 'inkDeleted'] as const)
    await db.clear(s);
});
describe('transactional local library', () => {
  it('imports binary separately and deduplicates without losing progress', async () => {
    await importDocument(meta(), new Blob(['first']));
    await saveProgress(id, { ...defaultProgress(), page: 1000, offset: 0.3 });
    await importDocument(meta(), new Blob(['same file']));
    expect(await listDocuments()).toHaveLength(1);
    expect((await listDocuments())[0].progress.page).toBe(1000);
    expect(await (await getFile(id))!.text()).toBe('same file');
  });
  it('persists, edits and deletes annotations', async () => {
    await importDocument(meta(), new Blob());
    const a = newAnnotation(id, 1000, 'note', { note: 'remember' });
    await saveAnnotation(a);
    expect((await getAnnotations(id))[0].note).toBe('remember');
    await saveAnnotation({ ...a, note: 'revised' });
    expect((await getAnnotations(id))[0].note).toBe('revised');
    await deleteAnnotation(a.id);
    expect(await getAnnotations(id)).toEqual([]);
  });
  it('rejects invalid geometry and orphan pages without writes', async () => {
    await importDocument(meta(), new Blob());
    await expect(saveAnnotation(newAnnotation(id, 1501, 'note'))).rejects.toThrow();
    await expect(
      saveAnnotation(
        newAnnotation(id, 1, 'highlight', { rects: [{ x: 0.9, y: 0, w: 0.2, h: 0.1 }] }),
      ),
    ).rejects.toThrow();
    expect(await getAnnotations(id)).toEqual([]);
  });
  it('rolls back metadata if saving the binary fails synchronously', async () => {
    const original = IDBObjectStore.prototype.put;
    const mock = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'files') throw new DOMException('full', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    });
    await expect(importDocument(meta(), new Blob(['pdf']))).rejects.toThrow();
    mock.mockRestore();
    expect(await listDocuments()).toEqual([]);
  });
  it('atomically removes documents and associated data', async () => {
    await importDocument(meta(), new Blob());
    await saveAnnotation(newAnnotation(id, 1, 'bookmark'));
    await removeDocument(id);
    expect(await listDocuments()).toEqual([]);
    expect(await getFile(id)).toBeUndefined();
    expect(await getAnnotations(id)).toEqual([]);
  });
  it('migration is idempotent for existing schema versions', async () => {
    const db = await database();
    migrateDatabase(db, 2);
    expect([...db.objectStoreNames]).toEqual([
      'annotations',
      'documents',
      'files',
      'ink',
      'inkDeleted',
      'settings',
    ]);
  });
  it('never moves an existing annotation to another document', async () => {
    await importDocument(meta(), new Blob());
    await importDocument(meta(id2), new Blob());
    const a = newAnnotation(id, 1, 'note');
    await saveAnnotation(a);
    await expect(saveAnnotation({ ...a, documentId: id2 })).rejects.toThrow('identity');
    expect(await getAnnotations(id)).toHaveLength(1);
  });
});
describe('portable backups', () => {
  it('round trips annotations and progress; missing PDFs can be reattached', async () => {
    await importDocument(meta(), new Blob(['pdf']));
    await saveProgress(id, { ...defaultProgress(), page: 1200 });
    await saveAnnotation(
      newAnnotation(id, 12, 'highlight', {
        rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
        text: 'Cells',
      }),
    );
    const b = await exportBackup();
    await removeDocument(id);
    await importBackup(JSON.parse(JSON.stringify(b)));
    expect((await listDocuments())[0].available).toBe(false);
    expect((await getAnnotations(id))[0].text).toBe('Cells');
    await importDocument(meta(), new Blob(['pdf']));
    expect((await listDocuments())[0].progress.page).toBe(1200);
    expect((await listDocuments())[0].available).toBe(true);
  });
  it('rejects unsupported versions, malformed progress and bad references', async () => {
    await importDocument(meta(), new Blob());
    const b = await exportBackup();
    for (const bad of [
      { ...b, version: 3 },
      { ...b, documents: [{ ...meta(), progress: { ...defaultProgress(), page: 0 } }] },
      { ...b, annotations: [newAnnotation(id2, 1, 'note')] },
    ])
      expect(() => validateBackup(bad)).toThrow();
  });
  it('a rejected import leaves existing data untouched', async () => {
    await importDocument(meta(), new Blob());
    const a = newAnnotation(id, 1, 'note', { note: 'keep' });
    await saveAnnotation(a);
    const b = await exportBackup();
    await expect(importBackup({ ...b, annotations: [{ ...a, version: 9 }] })).rejects.toThrow();
    expect((await getAnnotations(id))[0].note).toBe('keep');
  });
  it('rolls back all writes after a transactional conflict', async () => {
    await importDocument(meta(), new Blob());
    await importDocument(meta(id2), new Blob());
    const a = newAnnotation(id, 1, 'note');
    await saveAnnotation(a);
    const b = await exportBackup();
    b.documents[0].progress.page = 100;
    b.documents[0].lastOpened = 999;
    b.annotations = [{ ...a, documentId: id2 }];
    await expect(importBackup(b)).rejects.toThrow('identity');
    expect((await listDocuments()).find((d) => d.id === id)!.progress.page).toBe(1);
  });
  it('merges by updated timestamp and scopes document exports', async () => {
    await importDocument(meta(), new Blob());
    await importDocument(meta(id2), new Blob());
    const a = newAnnotation(id, 1, 'note', { note: 'new' });
    await saveAnnotation(a);
    const b = await exportBackup(id);
    expect(b.documents).toHaveLength(1);
    b.annotations[0].note = 'old';
    b.annotations[0].updatedAt = a.createdAt;
    await importBackup(b);
    expect((await getAnnotations(id))[0].note).toBe('new');
  });
});
describe('progress reliability', () => {
  it('coalesces while preserving the newest location', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = new ProgressWriter(write, vi.fn());
    for (let page = 1; page < 50; page++) writer.schedule({ ...defaultProgress(), page });
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].page).toBe(49);
    vi.useRealTimers();
  });
  it('reports failures and can retry pending progress', async () => {
    const error = vi.fn(),
      write = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    const writer = new ProgressWriter(write, error);
    writer.schedule(defaultProgress());
    await writer.flush();
    expect(error).toHaveBeenCalledOnce();
    await writer.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('never retries a failed old position after a newer queued write', async () => {
    let reject!: (e: unknown) => void;
    const first = new Promise<void>((_, r) => (reject = r));
    const write = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const writer = new ProgressWriter(write, vi.fn());
    writer.schedule({ ...defaultProgress(), page: 2 });
    const a = writer.flush();
    await Promise.resolve();
    writer.schedule({ ...defaultProgress(), page: 3 });
    const b = writer.flush();
    reject(new Error('disk'));
    await a;
    await b;
    await writer.flush();
    expect(write.mock.calls.map((c) => c[0].page)).toEqual([2, 3]);
  });
  it('explains quota failures', () => {
    expect(errorMessage(new DOMException('quota', 'QuotaExceededError'))).toContain(
      'Storage is full',
    );
  });
});
