import { database, abort } from './storage';
import { validateStrokes } from './core';
import type { InkChange, Stroke } from './ink-types';
export async function loadPageInk(documentId: string, page: number): Promise<Stroke[]> {
  return validateStrokes(
    await (await database()).getAllFromIndex('ink', 'by-page', [documentId, page]),
  );
}
const vectorIdentity = (s: Stroke) => JSON.stringify({ ...s, updatedAt: 0 });
/** One drawing/erasing/undo gesture is one atomic persistent mutation. */
export async function applyInkChange(change: InkChange): Promise<Stroke[]> {
  const before = validateStrokes(change.before),
    after = validateStrokes(change.after);
  if (
    [...before, ...after].some((s) => s.documentId !== change.documentId || s.page !== change.page)
  )
    throw new Error('Ink command crosses document or page boundaries.');
  const db = await database();
  const tx = db.transaction(['documents', 'ink', 'inkDeleted'], 'readwrite');
  try {
    const doc = await tx.objectStore('documents').get(change.documentId);
    if (!doc || change.page < 1 || change.page > doc.pageCount)
      throw new Error('Ink does not belong to a valid page.');
    let time = Date.now();
    for (const s of before) {
      const old = await tx.objectStore('ink').get(s.id);
      if (!old || vectorIdentity(old) !== vectorIdentity(s))
        throw new Error('Ink changed in another session. Reopen this document before editing.');
      time = Math.max(time, old.updatedAt + 1);
    }
    const replacing = new Set(before.map((s) => s.id));
    for (const s of after) {
      const old = await tx.objectStore('ink').get(s.id);
      const deleted = await tx.objectStore('inkDeleted').get(s.id);
      if ((old && !replacing.has(s.id)) || (deleted && deleted.documentId !== change.documentId))
        throw new Error('Stroke identity conflict.');
      time = Math.max(time, s.updatedAt + 1, deleted ? deleted.deletedAt + 1 : 0);
    }
    const afterIds = new Set(after.map((s) => s.id));
    for (const s of before) {
      await tx.objectStore('ink').delete(s.id);
      if (!afterIds.has(s.id))
        await tx
          .objectStore('inkDeleted')
          .put({ id: s.id, documentId: s.documentId, page: s.page, deletedAt: time });
    }
    const saved = after.map((s) => ({ ...s, updatedAt: time }));
    for (const s of saved) {
      await tx.objectStore('ink').put(s);
      await tx.objectStore('inkDeleted').delete(s.id);
    }
    await tx.done;
    return saved;
  } catch (e) {
    return abort(tx, e);
  }
}
