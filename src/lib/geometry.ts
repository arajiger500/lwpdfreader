import type { PageViewport } from 'pdfjs-dist';
import type { Rect } from './types';
export function screenToNormalized(
  rect: { left: number; top: number; right: number; bottom: number },
  viewport: PageViewport,
  box: number[],
): Rect {
  const [ax, ay] = viewport.convertToPdfPoint(rect.left, rect.top);
  const [bx, by] = viewport.convertToPdfPoint(rect.right, rect.bottom);
  const x = Math.max(0, Math.min(1, (Math.min(ax, bx) - box[0]) / (box[2] - box[0])));
  const y = Math.max(0, Math.min(1, (Math.min(ay, by) - box[1]) / (box[3] - box[1])));
  return {
    x,
    y,
    w: Math.max(0, Math.min(1 - x, Math.abs(ax - bx) / (box[2] - box[0]))),
    h: Math.max(0, Math.min(1 - y, Math.abs(ay - by) / (box[3] - box[1]))),
  };
}
export function normalizedToScreen(r: Rect, viewport: PageViewport, box: number[]) {
  const [x0, y0, x1, y1] = box;
  const points = [
    ...viewport.convertToViewportPoint(x0 + r.x * (x1 - x0), y0 + r.y * (y1 - y0)),
    ...viewport.convertToViewportPoint(x0 + (r.x + r.w) * (x1 - x0), y0 + (r.y + r.h) * (y1 - y0)),
  ];
  return {
    left: Math.min(points[0], points[2]),
    top: Math.min(points[1], points[3]),
    width: Math.abs(points[2] - points[0]),
    height: Math.abs(points[3] - points[1]),
  };
}
export function selectionRects(
  range: Range,
  bounds: DOMRect,
  viewport: PageViewport,
  box: number[],
): Rect[] {
  const rects = Array.from(range.getClientRects())
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .map((r) => ({
      left: Math.max(0, r.left - bounds.left),
      top: Math.max(0, r.top - bounds.top),
      right: Math.min(bounds.width, r.right - bounds.left),
      bottom: Math.min(bounds.height, r.bottom - bounds.top),
    }))
    .filter((r) => r.right > r.left && r.bottom > r.top);
  // A Range can return both span and text rectangles. Remove contained duplicates.
  const unique = rects.filter(
    (r, i) =>
      !rects.some(
        (s, j) =>
          j !== i &&
          (j < i || s.right - s.left > r.right - r.left + 0.1) &&
          s.left <= r.left + 0.5 &&
          s.top <= r.top + 0.5 &&
          s.right >= r.right - 0.5 &&
          s.bottom >= r.bottom - 0.5,
      ),
  );
  return unique.map((r) => screenToNormalized(r, viewport, box)).filter((r) => r.w > 0 && r.h > 0);
}
