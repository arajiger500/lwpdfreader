import { abort, database } from './storage';

export const BOARD_SIZE = 32768;
export const boardInkId = (id: string) => 'whiteboard:' + id;
export const boardIdFromInk = (id: string) => (id.startsWith('whiteboard:') ? id.slice(11) : '');
export type BoardBackground = 'blank' | 'grid' | 'dotted';
export interface BoardView {
  x: number;
  y: number;
  zoom: number;
}
export const validBoardView = (view: BoardView) =>
  view &&
  [view.x, view.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
  Number.isFinite(view.zoom) &&
  view.zoom >= 0.25 &&
  view.zoom <= 4;
export interface Whiteboard {
  id: string;
  title: string;
  background: BoardBackground;
  view?: BoardView;
  updatedAt: number;
  deleted: boolean;
}
export interface BoardAnchor {
  id: string;
  documentId: string;
  page: number;
  x: number;
  y: number;
  boardId: string;
  deleted: boolean;
}
export type AnchorPosition = Pick<BoardAnchor, 'page' | 'x' | 'y'>;
export const hasId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

export async function listBoards() {
  return (await (await database()).getAll('whiteboards'))
    .filter((board) => !board.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function documentAnchors(documentId: string) {
  const tx = (await database()).transaction(['boardAnchors', 'whiteboards']);
  const anchors = await tx.objectStore('boardAnchors').index('by-document').getAll(documentId);
  const boards = new Map<string, Whiteboard | undefined>();
  const linked = [];
  for (const anchor of anchors) {
    if (anchor.deleted) continue;
    if (!boards.has(anchor.boardId)) {
      boards.set(anchor.boardId, await tx.objectStore('whiteboards').get(anchor.boardId));
    }
    const board = boards.get(anchor.boardId);
    if (board && !board.deleted) linked.push({ ...anchor, title: board.title });
  }
  await tx.done;
  return linked;
}

export async function attachBoard(
  documentId: string,
  position: AnchorPosition,
  choice: { boardId: string } | { title: string },
) {
  const tx = (await database()).transaction(
    ['documents', 'whiteboards', 'boardAnchors'],
    'readwrite',
  );
  try {
    const doc = await tx.objectStore('documents').get(documentId);
    if (
      !doc ||
      !Number.isInteger(position.page) ||
      position.page < 1 ||
      position.page > doc.pageCount ||
      ![position.x, position.y].every(
        (coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1,
      )
    ) {
      throw new Error('Choose a point on a PDF page.');
    }
    const boards = tx.objectStore('whiteboards');
    const board: Whiteboard | undefined =
      'boardId' in choice
        ? await boards.get(choice.boardId)
        : {
            id: crypto.randomUUID(),
            title: boardTitle(choice.title),
            background: 'blank',
            updatedAt: Date.now(),
            deleted: false,
          };
    if (!board || board.deleted) throw new Error('This whiteboard was removed.');
    if ('title' in choice) await boards.add(board);
    const anchor: BoardAnchor = {
      ...position,
      documentId,
      id: crypto.randomUUID(),
      boardId: board.id,
      deleted: false,
    };
    await tx.objectStore('boardAnchors').add(anchor);
    await tx.done;
    return { anchor, board };
  } catch (error) {
    return abort(tx, error);
  }
}

function boardTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 120)
    throw new Error('Enter a whiteboard title of up to 120 characters.');
  return trimmed;
}

export async function updateBoard(
  id: string,
  change: Partial<Pick<Whiteboard, 'title' | 'background' | 'view'>>,
) {
  const tx = (await database()).transaction('whiteboards', 'readwrite');
  try {
    const old = await tx.store.get(id);
    if (!old || old.deleted) throw new Error('This whiteboard was removed.');
    if (change.view && !validBoardView(change.view)) throw new Error('Invalid whiteboard view.');
    const board = {
      ...old,
      ...change,
      title: boardTitle(change.title ?? old.title),
      updatedAt: Math.max(old.updatedAt + 1, Date.now()),
    };
    await tx.store.put(board);
    await tx.done;
    return board;
  } catch (error) {
    return abort(tx, error);
  }
}

export async function unlinkBoard(anchorId: string) {
  const tx = (await database()).transaction('boardAnchors', 'readwrite');
  try {
    const anchor = await tx.store.get(anchorId);
    if (anchor && !anchor.deleted) await tx.store.put({ ...anchor, deleted: true });
    await tx.done;
  } catch (error) {
    return abort(tx, error);
  }
}

export function boardTombstone(board: Whiteboard): Whiteboard {
  return {
    id: board.id,
    title: 'Whiteboard',
    background: 'blank',
    updatedAt: board.updatedAt,
    deleted: true,
  };
}

export async function deleteBoard(id: string) {
  const tx = (await database()).transaction(
    ['whiteboards', 'boardAnchors', 'ink', 'inkDeleted'],
    'readwrite',
  );
  try {
    const board = await tx.objectStore('whiteboards').get(id);
    if (board && !board.deleted) {
      await tx.objectStore('whiteboards').put(boardTombstone({ ...board, updatedAt: Date.now() }));
      const anchors = tx.objectStore('boardAnchors');
      for (const anchor of await anchors.index('by-board').getAll(id)) {
        if (!anchor.deleted) await anchors.put({ ...anchor, deleted: true });
      }
      for (const store of ['ink', 'inkDeleted'] as const) {
        const ink = tx.objectStore(store);
        for (const key of await ink.index('by-document').getAllKeys(boardInkId(id)))
          await ink.delete(key);
      }
    }
    await tx.done;
  } catch (error) {
    return abort(tx, error);
  }
}
