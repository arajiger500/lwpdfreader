import { PDFDocument, StandardFonts, rgb, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('tests/fixtures', { recursive: true });
async function fixture(count, name, mixed = false) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  for (let i = 0; i < count; i++) {
    const page = pdf.addPage(mixed && i === 2 ? [792, 612] : [612, 792]);
    const { height, width } = page.getSize();
    page.drawText('THE NATURAL WORLD', {
      x: 52,
      y: height - 60,
      size: 10,
      font: bold,
      color: rgb(0.3, 0.4, 0.3),
    });
    page.drawText(`Chapter ${Math.floor(i / 50) + 1}. A closer look`, {
      x: 52,
      y: height - 108,
      size: 25,
      font,
    });
    const lines = [
      `Page ${i + 1}. Biology is the study of life.`,
      `Cells are the fundamental units of every living organism.`,
      `Careful observation reveals patterns in the natural world.`,
      `Energy flows through ecosystems and matter is recycled.`,
      `Read, reflect, and connect these ideas to what you know.`,
    ];
    for (let j = 0; j < lines.length; j++)
      page.drawText(lines[j], { x: 52, y: height - 155 - j * 27, size: 14, font });
    page.drawRectangle({
      x: 52,
      y: height - 440,
      width: width - 104,
      height: 100,
      color: rgb(0.91, 0.94, 0.88),
    });
    page.drawText('A space to think', { x: 72, y: height - 390, size: 18, font });
    page.drawText(String(i + 1), { x: width / 2, y: 35, size: 10, font });
  }
  const outline = pdf.context.obj({ Type: 'Outlines', Count: 2 });
  const outlineRef = pdf.context.register(outline);
  const one = pdf.context.obj({
    Title: PDFString.of('Getting started'),
    Parent: outlineRef,
    Dest: [pdf.getPages()[0].ref, PDFName.of('Fit')],
  });
  const oneRef = pdf.context.register(one);
  const two = pdf.context.obj({
    Title: PDFString.of('A distant chapter'),
    Parent: outlineRef,
    Prev: oneRef,
    Dest: [pdf.getPages()[Math.min(count - 1, 999)].ref, PDFName.of('Fit')],
  });
  const twoRef = pdf.context.register(two);
  one.set(PDFName.of('Next'), twoRef);
  outline.set(PDFName.of('First'), oneRef);
  outline.set(PDFName.of('Last'), twoRef);
  pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
  await writeFile('tests/fixtures/' + name, await pdf.save());
}
await fixture(12, 'study.pdf', true);
await fixture(1500, 'large.pdf');
await writeFile('tests/fixtures/broken.pdf', '%PDF-1.7\nthis is corrupt');
console.log('Generated original 12-page and 1,500-page synthetic PDFs.');

// Intrinsically rotated crop-box fixture with non-default PDF UserUnit.
const { readFile } = await import('node:fs/promises');
const source = await PDFDocument.load(await readFile('tests/fixtures/study.pdf'));
const rotated = await PDFDocument.create();
const [cropped] = await rotated.copyPages(source, [0]);
rotated.addPage(cropped);
cropped.setCropBox(80, 40, 420, 600);
cropped.node.set(PDFName.of('Rotate'), PDFNumber.of(90));
cropped.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
await writeFile('tests/fixtures/rotated.pdf', await rotated.save());
