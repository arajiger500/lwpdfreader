// Optional stress fixture: 1,500 pages with 64 unique 2048px noise images.
// Deterministic original content; generated locally and intentionally not committed.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.TimesRoman);
const images = [];
let state = 12345;
function next() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state & 255;
}
for (let i = 0; i < 64; i++) {
  const pixels = Buffer.alloc(2048 * 2048 * 3);
  for (let j = 0; j < pixels.length; j++) pixels[j] = next();
  const jpeg = await sharp(pixels, { raw: { width: 2048, height: 2048, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
  images.push(await pdf.embedJpg(jpeg));
}
for (let i = 0; i < 1500; i++) {
  const p = pdf.addPage([612, 792]);
  p.drawText(`Page ${i + 1}. An original image-heavy stress fixture.`, {
    x: 40,
    y: 750,
    size: 14,
    font,
  });
  p.drawImage(images[i % images.length], { x: 40, y: 150, width: 532, height: 532 });
  p.drawText('Select this text to test annotations on an illustrated page.', {
    x: 40,
    y: 100,
    size: 12,
    font,
    color: rgb(0.1, 0.2, 0.1),
  });
}
await mkdir('tests/fixtures', { recursive: true });
const bytes = await pdf.save();
await writeFile('tests/fixtures/heavy.pdf', bytes);
console.log(`Generated ${bytes.length} bytes, 1,500 illustrated pages. Not a real textbook.`);
