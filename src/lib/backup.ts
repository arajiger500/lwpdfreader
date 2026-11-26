import type { Backup, DocumentMeta, Progress } from './types';
import { validateAnnotations, validateStrokes } from './core';
import type { InkDeleted } from './ink-types';
import { abort, database } from './storage';
import {
  boardIdFromInk,
  boardInkId,
  BOARD_SIZE,
  hasId,
  boardTombstone,
  validBoardView,
} from './whiteboard-storage';
const stores = [
  'documents',
  'annotations',
  'ink',
  'inkDeleted',
  'whiteboards',
  'boardAnchors',
] as const;
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
    (p.horizontal === undefined ||
      (Number.isFinite(p.horizontal) && p.horizontal >= 0 && p.horizontal <= 1)) &&
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
    ![1, 2, 3].includes(b.version) ||
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
  const whiteboards = b.version === 3 ? b.whiteboards : [];
  const boardAnchors = b.version === 3 ? b.boardAnchors : [];
  if (
    !Array.isArray(whiteboards) ||
    whiteboards.length > 10000 ||
    !Array.isArray(boardAnchors) ||
    boardAnchors.length > 100000
  )
    fail();
  const boards = new Map<string, boolean>();
  for (const board of whiteboards) {
    if (
      !board ||
      !hasId(board.id) ||
      boards.has(board.id) ||
      typeof board.title !== 'string' ||
      !board.title.trim() ||
      board.title.length > 120 ||
      !['blank', 'grid', 'dotted'].includes(board.background) ||
      !Number.isSafeInteger(board.updatedAt) ||
      board.updatedAt < 0 ||
      (board.view !== undefined && !validBoardView(board.view)) ||
      typeof board.deleted !== 'boolean'
    )
      fail();
    boards.set(board.id, board.deleted);
  }
  const anchors = new Set<string>();
  for (const link of boardAnchors) {
    if (
      !link ||
      !hasId(link.id) ||
      anchors.has(link.id) ||
      !hasId(link.boardId) ||
      typeof link.documentId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(link.documentId) ||
      typeof link.deleted !== 'boolean' ||
      !Number.isInteger(link.page) ||
      link.page < 1 ||
      link.page > 1e6 ||
      ![link.x, link.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
      (!link.deleted &&
        (boards.get(link.boardId) !== false ||
          !docs.has(link.documentId) ||
          link.page > docs.get(link.documentId)!.pageCount))
    )
      fail();
    anchors.add(link.id);
  }
  const validInkPage = (id: string, page: number) => {
    const board = boardIdFromInk(id);
    return board
      ? boards.get(board) === false && page === 1
      : page <= (docs.get(id)?.pageCount ?? 0);
  };
  const strokes = b.version === 1 ? [] : validateStrokes(b.strokes);
  if (b.version >= 2 && !Array.isArray(b.inkDeleted)) fail();
  const inkDeleted: InkDeleted[] = b.version === 1 ? [] : b.inkDeleted;
  const ids = new Set<string>();
  for (const stroke of strokes) {
    if (
      !validInkPage(stroke.documentId, stroke.page) ||
      (boardIdFromInk(stroke.documentId) &&
        (stroke.pageWidth !== BOARD_SIZE || stroke.pageHeight !== BOARD_SIZE))
    )
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
      !Number.isInteger(d.page) ||
      d.page < 1 ||
      !validInkPage(d.documentId, d.page) ||
      !Number.isSafeInteger(d.deletedAt) ||
      d.deletedAt < 0
    )
      fail();
    deletedIds.add(d.id);
  }
  return {
    format: 'LWPDFReader',
    version: b.version === 3 ? 3 : 2,
    ...(b.version === 3 ? { whiteboards, boardAnchors } : {}),
    strokes,
    inkDeleted,
    exportedAt: b.exportedAt,
    documents: b.documents,
    annotations,
  };
}
export async function exportBackup(documentId?: string): Promise<Backup> {
  const db = await database();
  const tx = db.transaction(stores);
  const docs = tx.objectStore('documents');
  const documents = documentId
    ? [await docs.get(documentId)].filter((doc): doc is DocumentMeta => !!doc)
    : await docs.getAll();
  const withDocument = <Name extends 'annotations' | 'ink' | 'inkDeleted' | 'boardAnchors'>(
    name: Name,
    id?: string,
  ) =>
    id
      ? tx.objectStore(name).index('by-document').getAll(IDBKeyRange.only(id))
      : tx.objectStore(name).getAll();
  const [annotations, strokes, inkDeleted, boardAnchors, allBoards] = await Promise.all([
    withDocument('annotations', documentId),
    withDocument('ink', documentId),
    withDocument('inkDeleted', documentId),
    withDocument('boardAnchors', documentId),
    tx.objectStore('whiteboards').getAll(),
  ]);
  const linked = new Set(boardAnchors.filter((a) => !a.deleted).map((a) => a.boardId));
  const whiteboards = allBoards.filter(
    (board) => !documentId || board.deleted || linked.has(board.id),
  );
  if (documentId) {
    const boardInk = await Promise.all(
      whiteboards
        .filter((board) => !board.deleted)
        .map(async (board) => {
          const id = boardInkId(board.id);
          return Promise.all([withDocument('ink', id), withDocument('inkDeleted', id)]);
        }),
    );
    for (const [saved, erased] of boardInk) {
      for (const stroke of saved) strokes.push(stroke);
      for (const tombstone of erased) inkDeleted.push(tombstone);
    }
  }
  await tx.done;
  const study = whiteboards.length || boardAnchors.length;
  return validateBackup({
    format: 'LWPDFReader',
    version: study ? 3 : 2,
    ...(study ? { whiteboards, boardAnchors } : {}),
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
  const tx = db.transaction(stores, 'readwrite');
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
    const boards = tx.objectStore('whiteboards');
    const links = tx.objectStore('boardAnchors');
    const unavailable = new Set<string>();
    for (const board of b.whiteboards ?? []) {
      const old = await boards.get(board.id);
      if (board.deleted || old?.deleted) {
        unavailable.add(boardInkId(board.id));
        if (!old?.deleted) {
          await boards.put(boardTombstone(board));
          for (const link of await links.index('by-board').getAll(board.id))
            if (!link.deleted) await links.put({ ...link, deleted: true });
          for (const name of ['ink', 'inkDeleted'] as const) {
            const ink = tx.objectStore(name);
            for (const id of await ink.index('by-document').getAllKeys(boardInkId(board.id)))
              await ink.delete(id);
          }
        }
      } else if (!old || board.updatedAt > old.updatedAt) await boards.put(board);
    }
    for (const link of b.boardAnchors ?? []) {
      const old = await links.get(link.id);
      if (
        old &&
        (old.documentId !== link.documentId ||
          old.boardId !== link.boardId ||
          old.page !== link.page ||
          old.x !== link.x ||
          old.y !== link.y)
      )
        throw new Error('Backup whiteboard link identity conflicts with local data.');
      if (!old || (!old.deleted && (link.deleted || unavailable.has(boardInkId(link.boardId))))) {
        await links.put({
          ...link,
          deleted: link.deleted || unavailable.has(boardInkId(link.boardId)),
        });
      }
    }
    for (const d of b.inkDeleted) {
      if (unavailable.has(d.documentId)) continue;
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
      if (unavailable.has(stroke.documentId)) continue;
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
    return abort(tx, e);
  }
  return (
    b.annotations.length +
    b.strokes.length +
    (b.whiteboards?.filter((board) => !board.deleted).length ?? 0)
  );
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
