/* tslint:disable */
/* eslint-disable */
export function canonical_annotations(input: string): string;
export function normalize_rect(x: number, y: number, w: number, h: number, width: number, height: number): string;
/**
 * Reusable index; construction and lookup are batched across the WASM boundary.
 */
export class AnnotationIndex {
  free(): void;
  [Symbol.dispose](): void;
  constructor(input: string);
  page(page: number): string;
  hit_test(page: number, x: number, y: number): string;
  intersect(page: number, x: number, y: number, w: number, h: number): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_annotationindex_free: (a: number, b: number) => void;
  readonly annotationindex_hit_test: (a: number, b: number, c: number, d: number) => [number, number];
  readonly annotationindex_intersect: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly annotationindex_new: (a: number, b: number) => [number, number, number];
  readonly annotationindex_page: (a: number, b: number) => [number, number];
  readonly canonical_annotations: (a: number, b: number) => [number, number, number, number];
  readonly normalize_rect: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
