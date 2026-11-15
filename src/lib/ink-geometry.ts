import type { PageViewport } from 'pdfjs-dist';
import type { InkPoint, Stroke } from './ink-types';
export function inkPoint(
  clientX: number,
  clientY: number,
  bounds: DOMRect,
  viewport: PageViewport,
  box: number[],
  pressure: number | null,
): InkPoint {
  const [x, y] = viewport.convertToPdfPoint(clientX - bounds.left, clientY - bounds.top);
  return {
    x: Math.max(0, Math.min(1, (x - box[0]) / (box[2] - box[0]))),
    y: Math.max(0, Math.min(1, (y - box[1]) / (box[3] - box[1]))),
    pressure,
  };
}
const round = (n: number) => Number(n.toFixed(4));
export function centerPath(points: InkPoint[], w: number, h: number, x = 0, y = 0): string {
  return points
    .map((p, i) => `${i ? 'L' : 'M'}${round(x + p.x * w)} ${round(y + p.y * h)}`)
    .join(' ');
}
/** A single filled outline gives variable width without alpha being applied per segment. */
export function penOutline(
  points: InkPoint[],
  w: number,
  h: number,
  width: number,
  x = 0,
  y = 0,
): string {
  if (!points.length) return '';
  const pos = points.map((p) => ({
    x: x + p.x * w,
    y: y + p.y * h,
    r: (width * (p.pressure === null ? 1 : 0.5 + p.pressure)) / 2,
  }));
  if (pos.length === 1) {
    const p = pos[0];
    return `M${p.x - p.r} ${p.y}a${p.r} ${p.r} 0 1 0 ${2 * p.r} 0a${p.r} ${p.r} 0 1 0 ${-2 * p.r} 0Z`;
  }
  const left: { x: number; y: number }[] = [],
    right: { x: number; y: number }[] = [];
  for (let i = 0; i < pos.length; i++) {
    const prev = pos[Math.max(0, i - 1)],
      next = pos[Math.min(pos.length - 1, i + 1)];
    let dx = next.x - prev.x,
      dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const p = pos[i];
    left.push({ x: p.x - dy * p.r, y: p.y + dx * p.r });
    right.push({ x: p.x + dy * p.r, y: p.y - dx * p.r });
  }
  const end = pos.at(-1)!,
    start = pos[0];
  const a = right.at(-1)!,
    b = left[0];
  return (
    `M${round(b.x)} ${round(b.y)} ` +
    left
      .slice(1)
      .map((p) => `L${round(p.x)} ${round(p.y)}`)
      .join(' ') +
    ` A${end.r} ${end.r} 0 0 0 ${round(a.x)} ${round(a.y)} ` +
    right
      .slice(0, -1)
      .reverse()
      .map((p) => `L${round(p.x)} ${round(p.y)}`)
      .join(' ') +
    ` A${start.r} ${start.r} 0 0 0 ${round(b.x)} ${round(b.y)}Z`
  );
}
export function strokePath(s: Stroke, box: number[]) {
  const w = box[2] - box[0],
    h = box[3] - box[1];
  return s.kind === 'pen' && s.points.some((p) => p.pressure !== null)
    ? penOutline(s.points, w, h, s.width * Math.min(w, h), box[0], box[1])
    : centerPath(s.points, w, h, box[0], box[1]);
}
export function groupStrokes(
  strokes: Stroke[],
): { rootId: string; kind: Stroke['kind']; color: string; opacity: number; strokes: Stroke[] }[] {
  const map = new Map<string, ReturnType<typeof groupStrokes>[number]>();
  for (const stroke of strokes) {
    const key = [stroke.rootId, stroke.color, stroke.opacity, stroke.kind].join(':');
    let group = map.get(key);
    if (!group) {
      group = {
        rootId: key,
        kind: stroke.kind,
        color: stroke.color,
        opacity: stroke.opacity,
        strokes: [],
      };
      map.set(key, group);
    }
    group.strokes.push(stroke);
  }
  return [...map.values()];
}
