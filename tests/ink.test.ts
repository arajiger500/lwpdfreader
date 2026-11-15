import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { openDB, deleteDB } from 'idb';
import { readFile } from 'node:fs/promises';
import init from '../src/wasm/lwpdf_core';
import { InkEraser, validateStrokes } from '../src/lib/core';
import { database, importDocument, migrateDatabase, removeDocument } from '../src/lib/storage';
import { loadPageInk, applyInkChange } from '../src/lib/ink-storage';
import { InkSession, type InkPageState } from '../src/lib/ink-session';
import { defaultProgress } from '../src/lib/types';
import { defaultInkSettings, validInkSettings, type Stroke } from '../src/lib/ink-types';
import { centerPath, penOutline, groupStrokes } from '../src/lib/ink-geometry';
import { exportBackup, importBackup, validateBackup } from '../src/lib/backup';
const id = 'c'.repeat(64);
const meta = {
  id,
  name: 'Ink.pdf',
  size: 123,
  pageCount: 1500,
  addedAt: 1,
  lastOpened: 1,
  available: true,
  progress: defaultProgress(),
};
const stroke = (name: string = crypto.randomUUID(), page = 1): Stroke => ({
  version: 1,
  id: name,
  rootId: name,
  documentId: id,
  page,
  kind: 'pen',
  color: '#222222',
  width: 0.004,
  opacity: 1,
  pageWidth: 600,
  pageHeight: 800,
  points: [
    { x: 0.1, y: 0.5, pressure: 0.2 },
    { x: 0.9, y: 0.5, pressure: 0.8 },
  ],
  createdAt: 1,
  updatedAt: 1,
});
beforeAll(async () => {
  await init({ module_or_path: await readFile('src/wasm/lwpdf_core_bg.wasm') });
});
beforeEach(async () => {
  const db = await database();
  for (const name of db.objectStoreNames) await db.clear(name);
  await importDocument(meta, new Blob(['pdf']));
});
async function watch(session: InkSession, page = 1) {
  let value: InkPageState = { strokes: [], loaded: false, error: null };
  let off = () => {};
  await new Promise<void>((resolve) => {
    off = session.subscribePage(page, (v) => {
      value = v;
      if (v.loaded) resolve();
    });
  });
  return {
    get value() {
      return value;
    },
    off,
  };
}
describe('ink storage and schema', () => {
  it('round trips pressure, opacity, normalized points and vector identity', async () => {
    const s = stroke();
    await applyInkChange({ documentId: id, page: 1, before: [], after: [s] });
    const [saved] = await loadPageInk(id, 1);
    expect({ ...saved, updatedAt: 1 }).toEqual(s);
    expect(await loadPageInk(id, 2)).toEqual([]);
  });
  it('rejects malformed vectors and invalid page references', async () => {
    expect(() =>
      validateStrokes([{ ...stroke(), points: [{ x: 2, y: 0, pressure: null }] }]),
    ).toThrow();
    await expect(
      applyInkChange({ documentId: id, page: 2000, before: [], after: [stroke('bad', 2000)] }),
    ).rejects.toThrow();
    expect(await loadPageInk(id, 1)).toEqual([]);
  });
  it('a failed multi-record write rolls back all ink and deletion records', async () => {
    const a = stroke('a');
    await applyInkChange({ documentId: id, page: 1, before: [], after: [a] });
    const original = IDBObjectStore.prototype.put;
    const mock = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'ink') throw new DOMException('full', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    });
    await expect(
      applyInkChange({ documentId: id, page: 1, before: [a], after: [stroke('b')] }),
    ).rejects.toThrow();
    mock.mockRestore();
    expect((await loadPageInk(id, 1)).map((s) => s.id)).toEqual(['a']);
    expect(await (await database()).getAll('inkDeleted')).toEqual([]);
  });
  it('upgrades a v1 database without touching existing study data', async () => {
    const name = 'lwpdf-v1-migration';
    await deleteDB(name);
    const old = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('documents', { keyPath: 'id' });
        db.createObjectStore('files');
        db.createObjectStore('annotations', { keyPath: 'id' }).createIndex(
          'by-document',
          'documentId',
        );
        db.createObjectStore('settings');
      },
    });
    await old.put('documents', meta);
    await old.put('annotations', { id: 'note', note: 'keep', documentId: id });
    old.close();
    const next = await openDB(name, 2, {
      upgrade(db, version) {
        migrateDatabase(db as unknown as Parameters<typeof migrateDatabase>[0], version);
      },
    });
    expect((await next.get('annotations', 'note')).note).toBe('keep');
    expect(await next.get('documents', id)).toEqual(meta);
    expect(await next.getAll('ink')).toEqual([]);
    next.close();
    await deleteDB(name);
  });
  it('removes strokes and tombstones with their document', async () => {
    const a = stroke();
    await applyInkChange({ documentId: id, page: 1, before: [], after: [a] });
    await applyInkChange({ documentId: id, page: 1, before: [a], after: [] });
    await removeDocument(id);
    expect(await (await database()).getAll('inkDeleted')).toEqual([]);
  });
});
describe('persistent session history and recovery', () => {
  it('undo and redo mutate actual IndexedDB and preserve vector appearance', async () => {
    const session = new InkSession(id, () => {});
    const page = await watch(session);
    const a = stroke('a');
    session.commit({ documentId: id, page: 1, before: [], after: [a] });
    expect(page.value.strokes).toHaveLength(1);
    await session.flush();
    await session.undo();
    expect(await loadPageInk(id, 1)).toEqual([]);
    await session.redo();
    expect((await loadPageInk(id, 1))[0].points).toEqual(a.points);
    page.off();
  });
  it('precision erasing, undo and redo restore the exact original geometry', async () => {
    const session = new InkSession(id, () => {});
    const page = await watch(session);
    const a = stroke('a');
    session.commit({ documentId: id, page: 1, before: [], after: [a] });
    await session.flush();
    const eraser = new InkEraser(JSON.stringify([a]));
    const { replacements } = JSON.parse(
      eraser.erase(
        JSON.stringify([
          { x: 0.5, y: 0.1, pressure: null },
          { x: 0.5, y: 0.9, pressure: null },
        ]),
        8,
        'precision',
        'both',
      ),
    );
    eraser.free();
    const after = replacements[0].segments.map((points: Stroke['points'], i: number) => ({
      ...a,
      id: 'split' + i,
      points,
    }));
    session.commit({ documentId: id, page: 1, before: [a], after });
    await session.flush();
    expect(await loadPageInk(id, 1)).toHaveLength(2);
    await session.undo();
    expect((await loadPageInk(id, 1))[0].points).toEqual(a.points);
    await session.redo();
    expect(await loadPageInk(id, 1)).toHaveLength(2);
    page.off();
  });
  it('retains failed optimistic strokes for retry and blocks misleading undo', async () => {
    const error = vi.fn();
    const session = new InkSession(id, error);
    const page = await watch(session);
    const original = IDBObjectStore.prototype.put;
    const mock = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'ink') throw new DOMException('full', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    });
    session.commit({ documentId: id, page: 1, before: [], after: [stroke()] });
    expect(await session.flush()).toBe(false);
    expect(page.value.strokes).toHaveLength(1);
    expect(await loadPageInk(id, 1)).toEqual([]);
    await session.undo();
    expect(page.value.strokes).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    mock.mockRestore();
    await session.retry();
    expect(await loadPageInk(id, 1)).toHaveLength(1);
    expect(await session.flush()).toBe(true);
    page.off();
  });
  it('bounds history and evicts unsubscribed page caches', async () => {
    const session = new InkSession(id, () => {});
    for (let n = 1; n <= 20; n++) {
      const page = await watch(session, n);
      page.off();
    }
    expect(session.stats().cachedPages).toBeLessThanOrEqual(12);
    const page = await watch(session);
    for (let i = 0; i < 85; i++) {
      session.commit({ documentId: id, page: 1, before: [], after: [stroke('stroke' + i)] });
      await session.flush();
    }
    expect(session.stats().historyPoints).toBeLessThanOrEqual(200000);
    let value;
    const off = session.status.subscribe((s) => (value = s));
    expect(value!.historyActions).toBe(80);
    off();
    page.off();
  });
  it('only updates subscribers on the affected page', async () => {
    const session = new InkSession(id, () => {});
    const one = await watch(session, 1),
      two = await watch(session, 2);
    const before = two.value;
    session.commit({ documentId: id, page: 1, before: [], after: [stroke()] });
    await session.flush();
    expect(two.value).toBe(before);
    one.off();
    two.off();
  });
});
it('groups long-stroke chunks into a single durable undo action', async () => {
  const session = new InkSession(id, () => {});
  const page = await watch(session);
  const first = stroke('first'),
    second = { ...stroke('second'), rootId: first.rootId };
  session.commit({ documentId: id, page: 1, before: [], after: [first] });
  session.commit({ documentId: id, page: 1, before: [], after: [second] });
  await session.flush();
  let actions = 0;
  const off = session.status.subscribe((s) => (actions = s.historyActions));
  expect(actions).toBe(1);
  await session.undo();
  expect(await loadPageInk(id, 1)).toEqual([]);
  await session.redo();
  expect(await loadPageInk(id, 1)).toHaveLength(2);
  off();
  page.off();
});
it('serializes concurrent history requests and can undo an evicted page', async () => {
  const error = vi.fn(),
    session = new InkSession(id, error),
    page = await watch(session);
  session.commit({ documentId: id, page: 1, before: [], after: [stroke('old')] });
  await session.flush();
  page.off();
  for (let n = 2; n < 24; n++) {
    const p = await watch(session, n);
    p.off();
  }
  await Promise.all([session.undo(), session.undo()]);
  expect(await loadPageInk(id, 1)).toEqual([]);
  expect(error).not.toHaveBeenCalled();
  await session.redo();
  expect(await loadPageInk(id, 1)).toHaveLength(1);
  expect(session.stats().cachedPages).toBeLessThanOrEqual(12);
});
describe('portable ink backups', () => {
  it('exports and imports vector strokes and supports old v1 backups', async () => {
    const a = stroke();
    await applyInkChange({ documentId: id, page: 1, before: [], after: [a] });
    const backup = await exportBackup(id);
    expect(backup.version).toBe(2);
    expect(backup.strokes).toHaveLength(1);
    await removeDocument(id);
    await importBackup(JSON.parse(JSON.stringify(backup)));
    expect((await loadPageInk(id, 1))[0].points).toEqual(a.points);
    const old = { ...backup, version: 1 };
    delete (old as Partial<typeof backup>).strokes;
    delete (old as Partial<typeof backup>).inkDeleted;
    expect(validateBackup(old).strokes).toEqual([]);
  });
  it('older backups cannot resurrect erased ink and newer undo can restore it', async () => {
    const a = stroke('a');
    await applyInkChange({ documentId: id, page: 1, before: [], after: [a] });
    const active = await exportBackup();
    await applyInkChange({ documentId: id, page: 1, before: [a], after: [] });
    const erased = await exportBackup();
    await importBackup(active);
    expect(await loadPageInk(id, 1)).toEqual([]);
    await applyInkChange({ documentId: id, page: 1, before: [], after: [a] });
    await importBackup(erased);
    expect(await loadPageInk(id, 1)).toHaveLength(1);
  });
  it('validates every stroke and tombstone before any import mutation', async () => {
    const b = await exportBackup();
    expect(() => validateBackup({ ...b, strokes: [{ ...stroke(), width: -1 }] })).toThrow();
    await expect(
      importBackup({ ...b, inkDeleted: [{ id: 'bad', documentId: id, page: 9999, deletedAt: 1 }] }),
    ).rejects.toThrow();
  });
});
describe('vector rendering and tool settings', () => {
  it('paths use PDF-space vectors so zoom only changes the viewport transform', () => {
    const a = stroke();
    expect(centerPath(a.points, 600, 800)).toBe('M60 400 L540 400');
    expect(penOutline(a.points, 600, 800, 2)).toContain('A');
    const pieces = [a, { ...a, id: 'fragment', points: [a.points[1]] }];
    const groups = groupStrokes(pieces.map((s) => ({ ...s, kind: 'marker', opacity: 0.28 })));
    expect(groups).toHaveLength(1);
    expect(groups[0].opacity).toBe(0.28);
    expect(groups[0].strokes).toHaveLength(2);
  });
  it('invalid preferences fall back safely and preserve custom valid colors', () => {
    expect(validInkSettings({ tool: 'fake' })).toEqual(defaultInkSettings());
    const custom = { ...defaultInkSettings(), penColor: '#abc123', fingerDrawing: true };
    expect(validInkSettings(custom)).toEqual(custom);
  });
});
