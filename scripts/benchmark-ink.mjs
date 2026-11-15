import { readFile, writeFile, mkdir } from 'node:fs/promises';
import init, { InkEraser, canonical_strokes } from '../src/wasm/lwpdf_core.js';
await init({ module_or_path: await readFile('src/wasm/lwpdf_core_bg.wasm') });
const strokes = Array.from({ length: 5000 }, (_, i) => ({
  version: 1,
  id: 's' + i,
  rootId: 's' + i,
  documentId: 'd'.repeat(64),
  page: 1,
  kind: i % 5 ? 'pen' : 'marker',
  color: '#2255aa',
  width: 0.003,
  opacity: i % 5 ? 1 : 0.28,
  pageWidth: 600,
  pageHeight: 800,
  points: Array.from({ length: 12 }, (_, j) => ({
    x: 0.02 + (i % 80) * 0.011 + j * 0.0008,
    y: 0.05 + Math.floor(i / 80) * 0.013 + Math.sin(j) * 0.001,
    pressure: null,
  })),
  createdAt: i,
  updatedAt: i,
}));
const json = JSON.stringify(strokes);
let time = performance.now();
canonical_strokes(json);
const validationMs = performance.now() - time;
time = performance.now();
const eraser = new InkEraser(json);
const indexBuildMs = performance.now() - time;
const samples = [];
for (let i = 0; i < 30; i++) {
  const path = [
    { x: 0.2 + i * 0.01, y: 0.4, pressure: null },
    { x: 0.205 + i * 0.01, y: 0.405, pressure: null },
  ];
  time = performance.now();
  eraser.erase(JSON.stringify(path), 5, 'precision', 'both');
  samples.push(performance.now() - time);
}
eraser.free();
const sorted = [...samples].sort((a, b) => a - b);
const report = {
  date: new Date().toISOString(),
  environment: 'Node ' + process.version + ' on Linux; real production WASM',
  strokes: 5000,
  points: 60000,
  jsonBytes: Buffer.byteLength(json),
  validationMs,
  indexBuildMs,
  eraserBatchMedianMs: (sorted[14] + sorted[15]) / 2,
  eraserBatchMaxMs: sorted.at(-1),
  samples,
};
await mkdir('docs/benchmarks', { recursive: true });
await writeFile('docs/benchmarks/ink-core.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
