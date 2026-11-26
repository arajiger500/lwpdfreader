import { BOARD_SIZE } from './whiteboard-storage';
import { strokeOrder, type Stroke } from './ink-types';

export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const cellSize = 512;
const intersects = (a: Area, b: Area) =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Bounds are in board coordinates, with row zero at the top of the board. */
export class BoardStrokeIndex {
  private cells = new Map<number, { stroke: Stroke; bounds: Area }[]>();
  private wide: { stroke: Stroke; bounds: Area }[] = [];
  private roots = new Map<string, Stroke[]>();
  constructor(strokes: Stroke[]) {
    for (const stroke of strokes) {
      const root = this.roots.get(stroke.rootId);
      if (root) root.push(stroke);
      else this.roots.set(stroke.rootId, [stroke]);
      const pad = stroke.width * BOARD_SIZE * 0.75;
      const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (const p of stroke.points) {
        const x = p.x * BOARD_SIZE;
        const y = (1 - p.y) * BOARD_SIZE;
        bounds.left = Math.min(bounds.left, x - pad);
        bounds.right = Math.max(bounds.right, x + pad);
        bounds.top = Math.min(bounds.top, y - pad);
        bounds.bottom = Math.max(bounds.bottom, y + pad);
      }
      const entry = { stroke, bounds };
      if (
        Math.ceil((bounds.right - bounds.left) / cellSize + 1) *
          Math.ceil((bounds.bottom - bounds.top) / cellSize + 1) >
        32
      ) {
        this.wide.push(entry);
      } else {
        for (const cell of this.keys(bounds)) {
          const entries = this.cells.get(cell);
          if (entries) entries.push(entry);
          else this.cells.set(cell, [entry]);
        }
      }
    }
  }
  private *keys(bounds: Area) {
    const cols = BOARD_SIZE / cellSize;
    for (
      let y = Math.max(0, Math.floor(bounds.top / cellSize));
      y <= Math.min(cols - 1, Math.floor(bounds.bottom / cellSize));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(bounds.left / cellSize));
        x <= Math.min(cols - 1, Math.floor(bounds.right / cellSize));
        x++
      )
        yield y * cols + x;
    }
  }
  query(area: Area, wholeStroke = false) {
    const visible = new Set<Stroke>();
    const consider = ({ stroke, bounds }: { stroke: Stroke; bounds: Area }) => {
      if (visible.has(stroke) || !intersects(bounds, area)) return;
      if (wholeStroke) {
        for (const part of this.roots.get(stroke.rootId)!) visible.add(part);
      } else visible.add(stroke);
    };
    for (const key of this.keys(area)) {
      for (const entry of this.cells.get(key) ?? []) consider(entry);
    }
    for (const entry of this.wide) consider(entry);
    return [...visible].sort(strokeOrder);
  }
}
