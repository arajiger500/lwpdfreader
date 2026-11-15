export interface Size {
  width: number;
  height: number;
}
export function offsets(
  count: number,
  measured: Map<number, Size>,
  fallback: Size,
  scale: number | ((size: Size) => number),
  rotation: number,
): number[] {
  const result = [0];
  for (let i = 1; i <= count; i++) {
    const size = measured.get(i) ?? fallback;
    result.push(
      result[i - 1] +
        (rotation % 180 ? size.width : size.height) *
          (typeof scale === 'number' ? scale : scale(size)) +
        20,
    );
  }
  return result;
}
export function pageAt(tops: number[], y: number): number {
  let lo = 0,
    hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y + 0.75) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
export function visiblePages(tops: number[], top: number, height: number): number[] {
  const first = Math.max(1, pageAt(tops, top) - 1);
  const last = Math.min(tops.length - 1, pageAt(tops, top + height) + 1);
  // Limit live canvases even at tiny zoom or unusually tall viewports.
  return Array.from({ length: Math.min(9, last - first + 1) }, (_, i) => first + i);
}
