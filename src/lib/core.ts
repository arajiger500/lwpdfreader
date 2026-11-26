import init, {
  canonical_annotations,
  AnnotationIndex,
  canonical_strokes,
  InkEraser,
} from '../wasm/lwpdf_core';
import type { Stroke } from './ink-types';
import type { Annotation } from './types';
let ready: Promise<unknown> | undefined;
export function initCore() {
  return (ready ??= init().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
export function validateAnnotations(items: unknown): Annotation[] {
  return JSON.parse(canonical_annotations(JSON.stringify(items))) as Annotation[];
}
export { AnnotationIndex };

export function validateStrokes(items: unknown): Stroke[] {
  return JSON.parse(canonical_strokes(JSON.stringify(items))) as Stroke[];
}
export { InkEraser };
