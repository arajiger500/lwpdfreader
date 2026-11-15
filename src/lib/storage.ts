import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Annotation, DocumentMeta, Progress } from './types';
import { validateAnnotations } from './core';

interface Schema extends DBSchema {
  documents: { key: string; value: DocumentMeta };
  files: { key: string; value: Blob };
  annotations: { key: string; value: Annotation; indexes: { 'by-document': string } };
  settings: { key: string; value: unknown };
}

export function migrateDatabase(db: IDBPDatabase<Schema>, oldVersion: number) {
  if (oldVersion < 1) {
    db.createObjectStore('documents', { keyPath: 'id' });
    db.createObjectStore('files');
    db.createObjectStore('annotations', { keyPath: 'id' }).createIndex('by-document', 'documentId');
    db.createObjectStore('settings');
  }
}

// Synchronous request errors do not necessarily abort an IDB transaction.
// Explicitly abort and consume tx.done for every failed multi-step mutation.
async function abort(
  tx: { abort(): void; done: Promise<unknown> },
  error: unknown,
): Promise<never> {
  try {
    tx.abort();
  } catch {
    /* The transaction may already have aborted. */
  }
  await tx.done.catch(() => {});
  throw error;
}

let connection: Promise<IDBPDatabase<Schema>> | undefined;
export function database() {
  return (connection ??= openDB<Schema>('lwpdfreader', 1, {
    upgrade: migrateDatabase,
    blocking() {
      void connection?.then((db) => db.close());
      connection = undefined;
    },
  }).catch((e) => {
    connection = undefined;
    throw e;
  }));
}
export const listDocuments = async () =>
  (await (await database()).getAll('documents')).sort((a, b) => b.lastOpened - a.lastOpened);
export const getFile = async (id: string) => (await database()).get('files', id);
export const getAnnotations = async (id: string) =>
  validateAnnotations(await (await database()).getAllFromIndex('annotations', 'by-document', id));

export async function importDocument(meta: DocumentMeta, file: Blob) {
  const db = await database();
  const tx = db.transaction(['documents', 'files'], 'readwrite');
  try {
    const existing = await tx.objectStore('documents').get(meta.id);
    if (existing && existing.pageCount !== meta.pageCount)
      throw new Error('Backup page count does not match this original PDF.');
    const saved = existing ? { ...existing, available: true, lastOpened: Date.now() } : meta;
    await tx.objectStore('documents').put(saved);
    await tx.objectStore('files').put(file, meta.id);
    await tx.done;
    return saved;
  } catch (e) {
    return abort(tx, e);
  }
}

export async function saveAnnotation(item: Annotation) {
  const [valid] = validateAnnotations([item]);
  const db = await database();
  const tx = db.transaction(['documents', 'annotations'], 'readwrite');
  try {
    const doc = await tx.objectStore('documents').get(valid.documentId);
    if (!doc || valid.page > doc.pageCount)
      throw new Error('Annotation does not belong to a valid page.');
    const existing = await tx.objectStore('annotations').get(valid.id);
    if (existing && existing.documentId !== valid.documentId)
      throw new Error('Annotation identity conflict.');
    await tx.objectStore('annotations').put(valid);
    await tx.done;
  } catch (e) {
    return abort(tx, e);
  }
}

export async function deleteAnnotation(id: string) {
  const db = await database();
  const tx = db.transaction('annotations', 'readwrite');
  try {
    await tx.store.delete(id);
    await tx.done;
  } catch (e) {
    return abort(tx, e);
  }
}

export async function saveProgress(id: string, progress: Progress) {
  const db = await database();
  const tx = db.transaction(['documents', 'settings'], 'readwrite');
  try {
    const doc = await tx.objectStore('documents').get(id);
    if (!doc)
      throw new Error('This document was removed. Its reading position could not be saved.');
    await tx.objectStore('documents').put({ ...doc, progress, lastOpened: Date.now() });
    await tx.objectStore('settings').put(id, 'lastDocument');
    await tx.done;
  } catch (e) {
    return abort(tx, e);
  }
}

export async function removeDocument(id: string) {
  const db = await database();
  const tx = db.transaction(['documents', 'files', 'annotations', 'settings'], 'readwrite');
  try {
    await tx.objectStore('documents').delete(id);
    await tx.objectStore('files').delete(id);
    for (const key of await tx.objectStore('annotations').index('by-document').getAllKeys(id))
      await tx.objectStore('annotations').delete(key);
    if ((await tx.objectStore('settings').get('lastDocument')) === id)
      await tx.objectStore('settings').delete('lastDocument');
    await tx.done;
  } catch (e) {
    return abort(tx, e);
  }
}

export async function setSetting(key: string, value: unknown) {
  const db = await database();
  const tx = db.transaction('settings', 'readwrite');
  try {
    await tx.store.put(value, key);
    await tx.done;
  } catch (e) {
    return abort(tx, e);
  }
}
export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await database()).get('settings', key) as Promise<T | undefined>;
}
