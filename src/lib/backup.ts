import type { Backup, DocumentMeta, Progress } from './types';
import { validateAnnotations, validateStrokes } from './core';
import type { InkDeleted } from './ink-types';
import { database } from './storage';
function fail(): never {
  throw new Error('Invalid or unsupported LWPDFReader backup. No changes were made.');
}
function validProgress(p: Progress, pages: number) {
  return (
    p &&
    Number.isInteger(p.page) &&
    p.page >= 1 &&
    p.page <= pages &&
    Number.isFinite(p.offset) &&
    p.offset >= 0 &&
    p.offset <= 1 &&
    Number.isFinite(p.zoom) &&
    p.zoom >= 0.25 &&
    p.zoom <= 4 &&
    ['width', 'page', 'custom'].includes(p.fit) &&
    ['single', 'continuous'].includes(p.mode) &&
    [0, 90, 180, 270].includes(p.rotation)
  );
}
export function validateBackup(raw: unknown): Backup {
  if (!raw || typeof raw !== 'object') fail();
  const b = raw as Omit<Backup, 'version'> & { version: number };
  if (
    b.format !== 'LWPDFReader' ||
    ![1, 2].includes(b.version) ||
    !Number.isSafeInteger(b.exportedAt) ||
    !Array.isArray(b.documents) ||
    b.documents.length > 10000 ||
    !Array.isArray(b.annotations)
  )
    fail();
  const docs = new Map<string, DocumentMeta>();
  for (const d of b.documents) {
    if (
      !d ||
      typeof d.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(d.id) ||
      docs.has(d.id) ||
      typeof d.name !== 'string' ||
      d.name.length > 1024 ||
      !Number.isSafeInteger(d.size) ||
      d.size < 0 ||
      !Number.isInteger(d.pageCount) ||
      d.pageCount < 1 ||
      d.pageCount > 1e6 ||
      !Number.isSafeInteger(d.addedAt) ||
      !Number.isSafeInteger(d.lastOpened) ||
      typeof d.available !== 'boolean' ||
      !validProgress(d.progress, d.pageCount)
    )
      fail();
    docs.set(d.id, d);
  }
  const annotations = validateAnnotations(b.annotations);
  for (const a of annotations)
    if (!docs.has(a.documentId) || a.page > docs.get(a.documentId)!.pageCount) fail();
  const strokes = b.version === 1 ? [] : validateStrokes(b.strokes);
  if (b.version === 2 && !Array.isArray(b.inkDeleted)) fail();
  const inkDeleted: InkDeleted[] = b.version === 1 ? [] : b.inkDeleted;
  const ids = new Set<string>();
  for (const stroke of strokes) {
    if (!docs.has(stroke.documentId) || stroke.page > docs.get(stroke.documentId)!.pageCount)
      fail();
    ids.add(stroke.id);
  }
  const deletedIds = new Set<string>();
  for (const d of inkDeleted) {
    if (
      !d ||
      typeof d.id !== 'string' ||
      !d.id.length ||
      d.id.length > 128 ||
      ids.has(d.id) ||
      deletedIds.has(d.id) ||
      !docs.has(d.documentId) ||
      !Number.isInteger(d.page) ||
      d.page < 1 ||
      d.page > docs.get(d.documentId)!.pageCount ||
      !Number.isSafeInteger(d.deletedAt) ||
      d.deletedAt < 0
    )
      fail();
    deletedIds.add(d.id);
  }
  return {
    format: 'LWPDFReader',
    version: 2,
    strokes,
    inkDeleted,
    exportedAt: b.exportedAt,
    documents: b.documents,
    annotations,
  };
}
export async function exportBackup(documentId?: string): Promise<Backup> {
  const db = await database();
  const tx = db.transaction(['documents', 'annotations', 'ink', 'inkDeleted']);
  const documents = (await tx.objectStore('documents').getAll()).filter(
    (d) => !documentId || d.id === documentId,
  );
  const annotations = documentId
    ? await tx.objectStore('annotations').index('by-document').getAll(documentId)
    : await tx.objectStore('annotations').getAll();
  const strokes = documentId
    ? await tx.objectStore('ink').index('by-document').getAll(documentId)
    : await tx.objectStore('ink').getAll();
  const inkDeleted = documentId
    ? await tx.objectStore('inkDeleted').index('by-document').getAll(documentId)
    : await tx.objectStore('inkDeleted').getAll();
  await tx.done;
  return validateBackup({
    format: 'LWPDFReader',
    version: 2,
    strokes,
    inkDeleted,
    exportedAt: Date.now(),
    documents,
    annotations,
  });
}
export async function importBackup(raw: unknown) {
  const b = validateBackup(raw);
  const db = await database();
  const tx = db.transaction(['documents', 'annotations', 'ink', 'inkDeleted'], 'readwrite');
  try {
    for (const d of b.documents) {
      const existing = await tx.objectStore('documents').get(d.id);
      if (existing && existing.pageCount !== d.pageCount)
        throw new Error('Backup document page count conflicts with local data.');
      await tx.objectStore('documents').put(
        existing
          ? {
              ...existing,
              progress: d.lastOpened > existing.lastOpened ? d.progress : existing.progress,
              lastOpened: Math.max(d.lastOpened, existing.lastOpened),
            }
          : { ...d, available: false },
      );
    }
    for (const a of b.annotations) {
      const old = await tx.objectStore('annotations').get(a.id);
      if (old && old.documentId !== a.documentId)
        throw new Error('Backup annotation identity conflicts with another document.');
      if (!old || a.updatedAt > old.updatedAt) await tx.objectStore('annotations').put(a);
    }
    for (const d of b.inkDeleted) {
      const old = await tx.objectStore('ink').get(d.id),
        prior = await tx.objectStore('inkDeleted').get(d.id);
      if ((old && old.documentId !== d.documentId) || (prior && prior.documentId !== d.documentId))
        throw new Error('Backup ink identity conflicts with another document.');
      if ((!old || d.deletedAt >= old.updatedAt) && (!prior || d.deletedAt > prior.deletedAt)) {
        await tx.objectStore('ink').delete(d.id);
        await tx.objectStore('inkDeleted').put(d);
      }
    }
    for (const stroke of b.strokes) {
      const old = await tx.objectStore('ink').get(stroke.id),
        deleted = await tx.objectStore('inkDeleted').get(stroke.id);
      if (
        (old && old.documentId !== stroke.documentId) ||
        (deleted && deleted.documentId !== stroke.documentId)
      )
        throw new Error('Backup ink identity conflicts with another document.');
      if (
        (!old || stroke.updatedAt > old.updatedAt) &&
        (!deleted || stroke.updatedAt > deleted.deletedAt)
      ) {
        await tx.objectStore('ink').put(stroke);
        await tx.objectStore('inkDeleted').delete(stroke.id);
      }
    }
    await tx.done;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* already aborted */
    }
    await tx.done.catch(() => {});
    throw e;
  }
  return b.annotations.length + b.strokes.length;
}
export function downloadBackup(b: Backup, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.lwpdf.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
