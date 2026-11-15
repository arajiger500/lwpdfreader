import { describe, it, expect } from 'vitest';
import { offsets, pageAt, visiblePages } from '../src/lib/virtual';
import { normalizedToScreen, screenToNormalized } from '../src/lib/geometry';
import type { PageViewport } from 'pdfjs-dist';
describe('virtual page window', () => {
  it('finds distant pages and keeps a bounded live set', () => {
    const tops = offsets(1500, new Map(), { width: 612, height: 792 }, 1, 0);
    expect(pageAt(tops, tops[999] + 100)).toBe(1000);
    expect(visiblePages(tops, tops[999], 900).length).toBeLessThanOrEqual(5);
    expect(visiblePages(tops, 0, 100000).length).toBeLessThanOrEqual(9);
  });
  it('uses actual dimensions and rotation', () => {
    const tops = offsets(
      3,
      new Map([[2, { width: 800, height: 400 }]]),
      { width: 600, height: 800 },
      2,
      90,
    );
    expect(tops).toEqual([0, 1220, 2840, 4060]);
  });
  it('tolerates browser subpixel scroll rounding', () => {
    expect(pageAt([0, 1486.24, 2972.48], 1486)).toBe(2);
  });
  it('supports independent fit scales for mixed dimensions', () => {
    const tops = offsets(
      3,
      new Map([[2, { width: 800, height: 400 }]]),
      { width: 600, height: 800 },
      (size) => 600 / size.width,
      0,
    );
    expect(tops).toEqual([0, 820, 1140, 1960]);
  });
  it('clamps boundary lookups', () => {
    const tops = [0, 100, 200];
    expect(pageAt(tops, -10)).toBe(1);
    expect(pageAt(tops, 999)).toBe(2);
  });
});
describe('PDF coordinates', () => {
  for (const rotation of [0, 90, 180, 270])
    for (const scale of [0.5, 1, 3])
      it(`round trips crop box at rotation ${rotation}, scale ${scale}`, () => {
        const W = 600,
          H = 800;
        const point = (x: number, y: number) => {
          x -= 20;
          y -= 40;
          return rotation === 0
            ? [x * scale, (H - y) * scale]
            : rotation === 90
              ? [y * scale, x * scale]
              : rotation === 180
                ? [(W - x) * scale, y * scale]
                : [(H - y) * scale, (W - x) * scale];
        };
        const viewport = {
          convertToViewportPoint: point,
          convertToPdfPoint: (x: number, y: number) =>
            rotation === 0
              ? [x / scale + 20, H - y / scale + 40]
              : rotation === 90
                ? [y / scale + 20, x / scale + 40]
                : rotation === 180
                  ? [W - x / scale + 20, y / scale + 40]
                  : [W - y / scale + 20, H - x / scale + 40],
        } as unknown as PageViewport;
        const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.04 };
        const s = normalizedToScreen(r, viewport, [20, 40, 620, 840]);
        const back = screenToNormalized(
          { left: s.left, top: s.top, right: s.left + s.width, bottom: s.top + s.height },
          viewport,
          [20, 40, 620, 840],
        );
        for (const key of ['x', 'y', 'w', 'h'] as const) expect(back[key]).toBeCloseTo(r[key], 8);
      });
});
