// wasm-bindgen's downloaded and cargo-built CLIs attach different producer labels.
// Drop only that optional telemetry section; keep code, data and debugging names.
import { readFile, writeFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/normalize-wasm.mjs <artifact.wasm>');
const bytes = await readFile(path);
if (!WebAssembly.validate(bytes)) throw new Error('Invalid WASM artifact');
function unsigned(offset) {
  let value = 0;
  for (let shift = 0; shift < 35 && offset < bytes.length; shift += 7) {
    const byte = bytes[offset++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return [value, offset];
  }
  throw new Error('Invalid WASM section length');
}
const sections = [bytes.subarray(0, 8)];
for (let offset = 8; offset < bytes.length;) {
  const start = offset;
  const id = bytes[offset++];
  const [length, payload] = unsigned(offset);
  offset = payload + length;
  if (offset > bytes.length) throw new Error('Truncated WASM section');
  let producers = false;
  if (id === 0) {
    const [nameLength, nameStart] = unsigned(payload);
    producers = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8') === 'producers';
  }
  if (!producers) sections.push(bytes.subarray(start, offset));
}
const normalized = Buffer.concat(sections);
if (!WebAssembly.validate(normalized)) throw new Error('Invalid normalized WASM artifact');
await writeFile(path, normalized);
