// Optional stress fixture: 1,500 pages with 64 unique 2048px noise images.
// Deterministic original content; generated locally and intentionally not committed.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.TimesRoman);
const images = [];
const imageCount = Number(process.env.LWPDF_FIXTURE_IMAGES ?? 64);
if (!Number.isSafeInteger(imageCount) || imageCount < 1 || imageCount > 192)
  throw new Error('LWPDF_FIXTURE_IMAGES must be an integer from 1 to 192.');
const illustrated = imageCount !== 64;
let state = 12345;
function next() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state & 255;
}
for (let i = 0; i < imageCount; i++) {
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
  if (illustrated) {
    p.drawImage(images[i % images.length], { x: 40, y: 400, width: 252, height: 252 });
    p.drawImage(images[(i * 7 + 1) % images.length], { x: 320, y: 400, width: 252, height: 252 });
    p.drawText('Figure A. Study the structure and compare the layers.', {
      x: 40,
      y: 375,
      size: 10,
      font,
    });
    p.drawText('Figure B. Identify the changes between panels.', {
      x: 320,
      y: 375,
      size: 10,
      font,
    });
    const paragraph =
      'Compare the observations in both panels. Explain how changes in scale affect the interpretation.';
    for (let row = 0; row < 13; row++) {
      p.drawText(paragraph, { x: 40, y: 342 - row * 17, size: 12, font });
    }
  } else {
    p.drawImage(images[i % images.length], { x: 40, y: 150, width: 532, height: 532 });
  }
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
await writeFile('tests/fixtures/' + (illustrated ? 'illustrated.pdf' : 'heavy.pdf'), bytes);
console.log(`Generated ${bytes.length} bytes, 1,500 illustrated pages. Not a real textbook.`);
