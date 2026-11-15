import type { Backup, DocumentMeta, Progress } from './types';
import { validateAnnotations } from './core';
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
  const b = raw as Backup;
  if (
    b.format !== 'LWPDFReader' ||
    b.version !== 1 ||
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
  return {
    format: 'LWPDFReader',
    version: 1,
    exportedAt: b.exportedAt,
    documents: b.documents,
    annotations,
  };
}
export async function exportBackup(documentId?: string): Promise<Backup> {
  const db = await database();
  const tx = db.transaction(['documents', 'annotations']);
  const documents = (await tx.objectStore('documents').getAll()).filter(
    (d) => !documentId || d.id === documentId,
  );
  const annotations = documentId
    ? await tx.objectStore('annotations').index('by-document').getAll(documentId)
    : await tx.objectStore('annotations').getAll();
  await tx.done;
  return validateBackup({
    format: 'LWPDFReader',
    version: 1,
    exportedAt: Date.now(),
    documents,
    annotations,
  });
}
export async function importBackup(raw: unknown) {
  const b = validateBackup(raw);
  const db = await database();
  const tx = db.transaction(['documents', 'annotations'], 'readwrite');
  try {
    for (const d of b.documents) {
      const existing = await tx.objectStore('documents').get(d.id);
      if (existing && existing.pageCount !== d.pageCount)
        throw new Error('Backup document page count conflicts with local data.');
      await tx
        .objectStore('documents')
        .put(
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
  return b.annotations.length;
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
