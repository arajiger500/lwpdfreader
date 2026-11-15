import init, { canonical_annotations, AnnotationIndex } from '../wasm/lwpdf_core';
import type { Annotation } from './types';
let ready: Promise<unknown> | undefined;
export function initCore() {
  return (ready ??= init());
}
export function validateAnnotations(items: unknown): Annotation[] {
  return JSON.parse(canonical_annotations(JSON.stringify(items))) as Annotation[];
}
export { AnnotationIndex };
