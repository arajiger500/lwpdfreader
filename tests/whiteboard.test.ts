import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { readFile } from 'node:fs/promises';
import init from '../src/wasm/lwpdf_core';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { BoardStrokeIndex } from '../src/lib/board-viewport';
import { exportBackup, importBackup, validateBackup } from '../src/lib/backup';
import { InkFilter } from '../src/lib/ink-filter';
import { applyInkChange, loadPageInk } from '../src/lib/ink-storage';
import type { Stroke } from '../src/lib/ink-types';
import { database, importDocument, migrateDatabase, removeDocument } from '../src/lib/storage';
import { defaultProgress } from '../src/lib/types';
import {
  attachBoard,
  boardInkId,
  BOARD_SIZE,
  deleteBoard,
  documentAnchors,
  listBoards,
  unlinkBoard,
  updateBoard,
} from '../src/lib/whiteboard-storage';

const documentId = 'a'.repeat(64);
const other = 'b'.repeat(64);
const location = { page: 2, x: 0.23, y: 0.72 };
const meta = (id: string) => ({
  id,
  name: 'Study.pdf',
  pageCount: 3,
  available: true,
  size: 3,
  progress: defaultProgress(),
  addedAt: 0,
  lastOpened: 0,
});
const create = () => attachBoard(documentId, location, { title: 'Study notes' });
const stroke = (board: string, id = 'ink', x = 0.5, rootId = id): Stroke => ({
  id,
  rootId,
  documentId: boardInkId(board),
  page: 1,
  kind: 'pen',
  color: '#000000',
  width: 2 / BOARD_SIZE,
  opacity: 1,
  pageWidth: BOARD_SIZE,
  pageHeight: BOARD_SIZE,
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  points: [{ x, y: 0.5, pressure: 0.4 }],
});

beforeAll(async () => {
  await init({ module_or_path: await readFile('src/wasm/lwpdf_core_bg.wasm') });
});

beforeEach(async () => {
  const db = await database();
  const tx = db.transaction([...db.objectStoreNames], 'readwrite');
  for (const store of db.objectStoreNames) await tx.objectStore(store).clear();
  await tx.done;
  for (const id of [documentId, other]) await importDocument(meta(id), new Blob(['pdf']));
});

it.each([1, 2])(
  'migrates IndexedDB v%i to v3 while preserving prior documents and ink',
  async (version) => {
    const name = 'whiteboard-migration-' + version;
    const upgrade = (db: unknown, old: number) =>
      migrateDatabase(db as Parameters<typeof migrateDatabase>[0], old);
    const old = await openDB(name, version, { upgrade });
    await old.put('documents', meta(documentId));
    if (version === 2) await old.put('ink', { ...stroke('unused'), documentId });
    old.close();
    const next = await openDB(name, 3, { upgrade });
    expect(await next.get('documents', documentId)).toEqual(meta(documentId));
    expect(await next.count('ink')).toBe(version === 2 ? 1 : 0);
    expect(await next.count('whiteboards')).toBe(0);
    expect(await next.count('boardAnchors')).toBe(0);
    next.close();
    await deleteDB(name);
  },
);

it('restores scoped links and board ink, preserving a shared board when one anchor is unlinked', async () => {
  const { board, anchor } = await create();
  const shared = await attachBoard(other, { ...location, x: 0.9 }, { boardId: board.id });
  await updateBoard(board.id, { title: 'Renamed', background: 'dotted' });
  const ink = stroke(board.id);
  await applyInkChange({ documentId: ink.documentId, page: 1, before: [], after: [ink] });
  const scoped = await exportBackup(documentId);
  expect(scoped.version).toBe(3);
  expect(scoped.whiteboards).toMatchObject([{ title: 'Renamed', background: 'dotted' }]);
  expect(scoped.boardAnchors).toEqual([anchor]);
  expect(scoped.strokes).toMatchObject([ink].map(({ updatedAt: _, ...s }) => s));
  await unlinkBoard(anchor.id);
  await importBackup(scoped);
  expect(await documentAnchors(documentId)).toEqual([]);
  expect(await documentAnchors(other)).toMatchObject([{ id: shared.anchor.id, title: 'Renamed' }]);
  expect(await loadPageInk(ink.documentId, 1)).toHaveLength(1);
});

it('carries permanent deletions across restores in either order', async () => {
  const { board } = await create();
  const ink = stroke(board.id);
  await applyInkChange({ documentId: ink.documentId, page: 1, before: [], after: [ink] });
  const active = await exportBackup();
  await deleteBoard(board.id);
  const deleted = await exportBackup();
  await importBackup(active);
  expect(await listBoards()).toEqual([]);
  expect(await documentAnchors(documentId)).toEqual([]);
  expect(await loadPageInk(ink.documentId, 1)).toEqual([]);
  await (await database()).clear('whiteboards');
  await (await database()).clear('boardAnchors');
  await importBackup(active);
  expect(await listBoards()).toHaveLength(1);
  await importBackup(deleted);
  expect(await listBoards()).toEqual([]);
  expect(await loadPageInk(ink.documentId, 1)).toEqual([]);
  expect(validateBackup(await exportBackup()).version).toBe(3);
});

it('rolls back board creation if the anchor write fails and allows retry', async () => {
  const add = IDBObjectStore.prototype.add;
  const mock = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    if (this.name === 'boardAnchors') throw new DOMException('Storage quota', 'QuotaExceededError');
    return add.call(this, value, key);
  });
  try {
    await expect(create()).rejects.toThrow('Storage quota');
    expect(await listBoards()).toEqual([]);
  } finally {
    mock.mockRestore();
  }
  await create();
  expect(await documentAnchors(documentId)).toHaveLength(1);
});

it('tombstones links when a PDF is removed and reimported by hash', async () => {
  await create();
  const original = await exportBackup();
  await removeDocument(documentId);
  await importDocument(meta(documentId), new Blob(['pdf']));
  await importBackup(original);
  expect(await documentAnchors(documentId)).toEqual([]);
  expect(await listBoards()).toHaveLength(1);
});

it('culls detached parts of a wide board and can erase a whole stroke root', () => {
  const live = stroke('demo', 'near', 0.5);
  const remote = stroke('demo', 'far', 0.9, live.rootId);
  const index = new BoardStrokeIndex([remote, live]);
  const area = { left: 16000, top: 16000, right: 16500, bottom: 16500 };
  expect(index.query(area)).toEqual([live]);
  expect(index.query(area, true)).toHaveLength(2);
});

it('limits stabilization lag, smooths pressure and preserves the stroke endpoint', () => {
  const start = { x: 0.4, y: 0.6, pressure: 0.2 };
  const next = { x: 0.4008, y: 0.6, pressure: 0.9 };
  const medium = new InkFilter('medium', 1000, 600);
  expect(medium.sample(start, 0)).toEqual(start);
  const filtered = medium.sample(next, 8);
  expect(filtered.x).toBeGreaterThan(start.x);
  expect(filtered.x).toBeLessThan(next.x);
  expect(filtered.pressure).toBeGreaterThan(start.pressure);
  expect(filtered.pressure).toBeLessThan(next.pressure);
  const corner = { x: 0.49, y: 0.4, pressure: 1 };
  expect(medium.sample(corner, 32).x).toBeCloseTo(corner.x, 3);
  expect(medium.sample(corner, 40, true).y).toBe(corner.y);
  const off = new InkFilter('off', 1000, 600);
  off.sample(start, 0);
  expect(off.sample(next, 8)).toEqual(next);
});
