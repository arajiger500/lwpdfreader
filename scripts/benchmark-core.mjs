import { readFile, writeFile, mkdir } from 'node:fs/promises';
import init, { canonical_annotations, AnnotationIndex } from '../src/wasm/lwpdf_core.js';
await init({ module_or_path: await readFile('src/wasm/lwpdf_core_bg.wasm') });
const annotations = Array.from({ length: 10000 }, (_, i) => ({
  version: 1,
  id: 'a-' + i,
  documentId: 'a'.repeat(64),
  page: (i % 1500) + 1,
  kind: 'highlight',
  color: 'yellow',
  rects: [
    { x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
    { x: 0.1, y: 0.17, w: 0.2, h: 0.02 },
  ],
  text: 'Cells are the fundamental units of life.',
  note: 'Study this.',
  createdAt: 1,
  updatedAt: 2,
}));
const json = JSON.stringify(annotations);
let t = performance.now();
for (let i = 0; i < 20; i++) canonical_annotations(json);
const validationMs = (performance.now() - t) / 20;
t = performance.now();
const index = new AnnotationIndex(json);
const indexBuildMs = performance.now() - t;
t = performance.now();
for (let i = 0; i < 10000; i++) index.page((i % 1500) + 1);
const lookupMicros = ((performance.now() - t) * 1000) / 10000;
index.free();
const result = {
  date: new Date().toISOString(),
  environment: 'Node ' + process.version + ' on Linux, real committed WASM',
  annotations: 10000,
  rectangles: 20000,
  jsonBytes: Buffer.byteLength(json),
  validationAndCanonicalSerializationMs: validationMs,
  indexBuildMs,
  pageLookupMicros: lookupMicros,
};
await mkdir('docs/benchmarks', { recursive: true });
await writeFile('docs/benchmarks/core.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
