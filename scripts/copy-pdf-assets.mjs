import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/pdf', { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm'])
  cpSync(`node_modules/pdfjs-dist/${folder}`, `public/pdf/${folder}`, { recursive: true });
