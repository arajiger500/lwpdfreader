export type Color = 'yellow' | 'green' | 'blue' | 'pink';
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Annotation {
  version: 1;
  id: string;
  documentId: string;
  page: number;
  kind: 'highlight' | 'note' | 'bookmark';
  color: Color;
  rects: Rect[];
  text: string;
  note: string;
  createdAt: number;
  updatedAt: number;
}
export interface Progress {
  page: number;
  offset: number;
  zoom: number;
  fit: 'width' | 'page' | 'custom';
  mode: 'continuous' | 'single';
  rotation: number;
}
export interface DocumentMeta {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  addedAt: number;
  lastOpened: number;
  progress: Progress;
  available: boolean;
}
export interface Backup {
  format: 'LWPDFReader';
  version: 1;
  exportedAt: number;
  documents: DocumentMeta[];
  annotations: Annotation[];
}
export const defaultProgress = (): Progress => ({
  page: 1,
  offset: 0,
  zoom: 1,
  fit: 'width',
  mode: 'continuous',
  rotation: 0,
});
export const colors: Color[] = ['yellow', 'green', 'blue', 'pink'];
export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return 'Storage is full. Export your annotations, then free device storage or remove a PDF.';
  return error instanceof Error ? error.message : String(error);
}
export function newAnnotation(
  documentId: string,
  page: number,
  kind: Annotation['kind'],
  fields: Partial<Pick<Annotation, 'rects' | 'color' | 'text' | 'note'>> = {},
): Annotation {
  const now = Date.now();
  return {
    version: 1,
    id: crypto.randomUUID(),
    documentId,
    page,
    kind,
    color: 'yellow',
    rects: [],
    text: '',
    note: '',
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}
