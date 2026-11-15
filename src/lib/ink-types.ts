export interface InkPoint {
  x: number;
  y: number;
  pressure: number | null;
}
/** Bottom-left, unrotated crop-box coordinates. Width is relative to min(pageWidth,pageHeight). */
export interface Stroke {
  version: 1;
  id: string;
  rootId: string;
  documentId: string;
  page: number;
  kind: 'pen' | 'marker';
  color: string;
  width: number;
  opacity: number;
  pageWidth: number;
  pageHeight: number;
  points: InkPoint[];
  createdAt: number;
  updatedAt: number;
}
export interface InkDeleted {
  id: string;
  documentId: string;
  page: number;
  deletedAt: number;
}
export interface InkChange {
  documentId: string;
  page: number;
  before: Stroke[];
  after: Stroke[];
}
export type InkTool = 'hand' | 'text' | 'pen' | 'marker' | 'eraser';
export interface InkSettings {
  version: 1;
  tool: InkTool;
  penColor: string;
  markerColor: string;
  penWidth: number;
  markerWidth: number;
  eraserSize: number;
  eraserMode: 'stroke' | 'precision';
  eraserTarget: 'pen' | 'marker' | 'both';
  fingerDrawing: boolean;
  smoothing: boolean;
  collapsed: boolean;
}
export const defaultInkSettings = (): InkSettings => ({
  version: 1,
  tool: 'text',
  penColor: '#222222',
  markerColor: '#f5d742',
  penWidth: 2.2,
  markerWidth: 16,
  eraserSize: 18,
  eraserMode: 'precision',
  eraserTarget: 'both',
  fingerDrawing: false,
  smoothing: true,
  collapsed: false,
});
export const writingTool = (tool: InkTool) =>
  tool === 'pen' || tool === 'marker' || tool === 'eraser';
export function validInkSettings(raw: unknown): InkSettings {
  const fallback = defaultInkSettings();
  if (!raw || typeof raw !== 'object') return fallback;
  const s = raw as InkSettings;
  if (
    s.version !== 1 ||
    !['hand', 'text', 'pen', 'marker', 'eraser'].includes(s.tool) ||
    ![s.penColor, s.markerColor].every((c) => typeof c === 'string' && /^#[a-f0-9]{6}$/i.test(c)) ||
    !Number.isFinite(s.penWidth) ||
    s.penWidth < 0.5 ||
    s.penWidth > 40 ||
    !Number.isFinite(s.markerWidth) ||
    s.markerWidth < 2 ||
    s.markerWidth > 80 ||
    !Number.isFinite(s.eraserSize) ||
    s.eraserSize < 2 ||
    s.eraserSize > 100 ||
    !['stroke', 'precision'].includes(s.eraserMode) ||
    !['pen', 'marker', 'both'].includes(s.eraserTarget) ||
    [s.fingerDrawing, s.smoothing, s.collapsed].some((v) => typeof v !== 'boolean')
  )
    return fallback;
  return { ...s };
}
export function strokeOrder(a: Stroke, b: Stroke) {
  return a.createdAt - b.createdAt || a.rootId.localeCompare(b.rootId) || a.id.localeCompare(b.id);
}
