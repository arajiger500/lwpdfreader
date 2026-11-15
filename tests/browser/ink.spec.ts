import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
async function open(page: Page, file = process.env.LWPDF_INK_FIXTURE ?? 'study.pdf') {
  await page.goto('/');
  await page.getByLabel('Import PDF file', { exact: true }).setInputFiles('tests/fixtures/' + file);
  await expect(page.locator('.pdf-page[data-page="1"][data-rendered="true"]')).toBeVisible({
    timeout: 120000,
  });
  await page.getByLabel('Reading mode').selectOption('single');
  await page.getByLabel('Page fit').selectOption('page');
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await expect(page.locator('.pdf-page')).toHaveAttribute('data-rendered', 'true');
  await expect(page.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
}
async function draw(page: Page, points: number[][], awaitSaved = true) {
  const b = await page.locator('.pdf-page[data-page="1"] .ink-layer').boundingBox();
  if (!b) throw new Error('No ink page');
  await page.mouse.move(b.x + points[0][0] * b.width, b.y + points[0][1] * b.height);
  await page.mouse.down();
  for (const [x, y] of points.slice(1))
    await page.mouse.move(b.x + x * b.width, b.y + y * b.height, { steps: 20 });
  await page.mouse.up();
  if (awaitSaved) await expect(page.getByLabel('Undo ink')).toBeEnabled();
}
async function backup(page: Page) {
  await page.getByLabel('Toggle document sidebar').click();
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export document backup' }).click();
  const path = await (await promise).path();
  return JSON.parse(await readFile(path!, 'utf8'));
}
async function pixel(page: Page, x: number, y: number) {
  return [
    ...(await sharp(
      await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } }),
    )
      .removeAlpha()
      .raw()
      .toBuffer()),
  ];
}
async function penEvents(page: Page, points: number[][], release = true) {
  const b = (await page.locator('.ink-layer').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: b.x + points[0][0] * b.width,
    y: b.y + points[0][1] * b.height,
    button: 'left',
    buttons: 1,
    pointerType: 'pen',
    force: 0.2,
  });
  for (const [i, [x, y]] of points.slice(1).entries())
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: b.x + x * b.width,
      y: b.y + y * b.height,
      button: 'left',
      buttons: 1,
      pointerType: 'pen',
      force: 0.25 + (i % 4) * 0.18,
    });
  if (release) {
    const p = points.at(-1)!;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: b.x + p[0] * b.width,
      y: b.y + p[1] * b.height,
      button: 'left',
      buttons: 0,
      pointerType: 'pen',
      force: 0,
    });
  }
  await cdp.detach();
}
test('pen, translucent marker, precision erase, undo/redo, reload and portable backup', async ({
  page,
  context,
}) => {
  if (process.env.LWPDF_INK_FIXTURE) test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.evaluate(() => {
    (window as unknown as { pdfRenders: number }).pdfRenders = 0;
    document.addEventListener('page-rendered', () => {
      (window as unknown as { pdfRenders: number }).pdfRenders++;
    });
  });
  await page.getByLabel('Pen tool', { exact: true }).click();
  await draw(page, [
    [0.2, 0.6],
    [0.4, 0.56],
    [0.55, 0.62],
    [0.8, 0.6],
  ]);
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  await page.getByLabel('Freehand highlighter tool', { exact: true }).click();
  await draw(page, [
    [0.2, 0.7],
    [0.8, 0.7],
  ]);
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { pdfRenders: number }).pdfRenders)).toBe(
    0,
  );
  await page.getByLabel('Eraser tool', { exact: true }).click();
  await page.getByLabel('Tool options').click();
  await page.getByLabel('Erase target').selectOption('marker');
  await page.getByLabel('Eraser mode').selectOption('precision');
  await page.getByLabel('Tool options').click();
  await draw(page, [
    [0.5, 0.64],
    [0.5, 0.77],
  ]);
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(2);
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  await page.getByLabel('Undo ink').click();
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(1);
  await page.getByLabel('Redo ink').click();
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(2);
  const data = await backup(page);
  expect(data.version).toBe(2);
  expect(data.strokes).toHaveLength(3);
  expect(data.inkDeleted).toHaveLength(1);
  expect(
    data.strokes
      .filter((s: { kind: string }) => s.kind === 'marker')
      .every((s: { opacity: number }) => s.opacity === 0.28),
  ).toBe(true);
  await page.reload();
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(2);
  await expect(page.getByLabel('Undo ink')).toBeDisabled();
  await page.getByLabel('Eraser tool', { exact: true }).click();
  await page.getByLabel('Tool options').click();
  await page.getByLabel('Eraser mode').selectOption('stroke');
  await page.getByLabel('Tool options').click();
  await draw(page, [
    [0.3, 0.68],
    [0.3, 0.72],
  ]);
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(0);
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  await page.getByLabel('Undo ink').click();
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(2);
  await page.getByLabel('Back to library').click();
  await page.getByLabel('Import annotation backup', { exact: true }).setInputFiles({
    name: 'ink.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  await page.locator('.document-open').click();
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(2);
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  await expect(page.locator('.ink-marker-layer [data-stroke]')).toHaveCount(2);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});
test('marker self-overlap has one translucent paint and remains behind opaque pen', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Freehand highlighter tool', { exact: true }).click();
  await draw(page, [
    [0.2, 0.7],
    [0.8, 0.7],
    [0.2, 0.7],
  ]);
  const b = (await page.locator('.ink-layer').boundingBox())!;
  const one = await pixel(page, b.x + b.width * 0.3, b.y + b.height * 0.7),
    two = await pixel(page, b.x + b.width * 0.5, b.y + b.height * 0.7);
  expect(one[0]).toBeGreaterThan(240);
  expect(one[1]).toBeGreaterThan(225);
  expect(one[2]).toBeLessThan(225);
  for (let i = 0; i < 3; i++) expect(Math.abs(one[i] - two[i])).toBeLessThan(4);
  await page.getByLabel('Pen tool', { exact: true }).click();
  await draw(page, [
    [0.5, 0.65],
    [0.5, 0.75],
  ]);
  const pen = await pixel(page, b.x + b.width * 0.5, b.y + b.height * 0.7);
  expect(Math.max(...pen)).toBeLessThan(100);
});
test('Pencil-style pressure, cancellation and rotation preserve normalized vector geometry', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Pen tool', { exact: true }).click();
  await penEvents(page, [
    [0.2, 0.6],
    [0.3, 0.59],
    [0.4, 0.62],
    [0.5, 0.6],
    [0.6, 0.61],
    [0.7, 0.6],
  ]);
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  const original = await page.locator('.ink-layer [data-stroke]').getAttribute('d');
  await page.getByLabel('Zoom in', { exact: true }).click();
  await expect(page.locator('.pdf-page[data-rendered="true"]')).toBeVisible();
  expect(await page.locator('.ink-layer [data-stroke]').getAttribute('d')).toBe(original);
  await page.getByLabel('Rotate clockwise').click();
  await expect(page.locator('.pdf-page[data-rendered="true"]')).toBeVisible();
  expect(await page.locator('.ink-layer [data-stroke]').getAttribute('d')).toBe(original);
  const data = await backup(page);
  expect(data.strokes[0].points.some((p: { pressure: number | null }) => p.pressure !== null)).toBe(
    true,
  );
  await page.getByLabel('Close sidebar', { exact: true }).click();
  await page.getByLabel('Page fit').selectOption('page');
  await page.evaluate(() =>
    document
      .querySelector('.ink-layer')!
      .addEventListener(
        'pointerdown',
        (e) =>
          ((window as unknown as { inkPointer: number }).inkPointer = (
            e as PointerEvent
          ).pointerId),
      ),
  );
  await penEvents(
    page,
    [
      [0.3, 0.7],
      [0.4, 0.7],
      [0.5, 0.7],
    ],
    false,
  );
  const pointerId = await page.evaluate(
    () => (window as unknown as { inkPointer: number }).inkPointer,
  );
  await page
    .locator('.ink-layer')
    .dispatchEvent('pointercancel', { pointerId, pointerType: 'pen' });
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(2);
});
test('fingers pan by default, optional finger drawing works, and Hand draws nothing', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Reading mode').selectOption('continuous');
  await page.getByLabel('Page fit').selectOption('width');
  await page.getByLabel('Pen tool', { exact: true }).click();
  const b = (await page.locator('.pdf-page[data-page="1"] .ink-layer').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: b.x + b.width * 0.5, y: 500 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: b.x + b.width * 0.5, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(() => page.locator('.viewer').evaluate((e) => e.scrollTop))
    .toBeGreaterThan(100);
  await expect(page.locator('[data-stroke]')).toHaveCount(0);
  await page.getByLabel('Page number', { exact: true }).fill('1');
  await page.getByLabel('Page number', { exact: true }).press('Enter');
  await page.waitForTimeout(500);
  await page.getByLabel('Tool options').click();
  await page.getByLabel('Draw with a finger').check();
  await page.getByLabel('Tool options').click();
  const layer = page.locator('.pdf-page[data-page="1"] .ink-layer');
  const box = (await layer.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + 100, y: 400 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: box.x + 200, y: 450 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(layer.locator('[data-stroke]')).toHaveCount(1);
  await cdp.detach();
  await page.getByLabel('Hand tool', { exact: true }).click();
  await draw(page, [
    [0.2, 0.3],
    [0.8, 0.35],
  ]);
  await expect(layer.locator('[data-stroke]')).toHaveCount(1);
  await page.getByLabel('Collapse annotation tools').click();
  await expect(page.getByLabel('Show annotation tools')).toBeVisible();
  await page.getByLabel('Show annotation tools').click();
  await expect(page.getByLabel('Hand tool', { exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByLabel('Focus reading').click();
  await expect(page.getByRole('toolbar', { name: 'Annotation tools', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Show controls/ }).click();
  await expect(page.getByLabel('Hand tool', { exact: true })).toBeVisible();
});
test('failed stroke writes remain visible, block leaving and recover on retry', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Pen tool', { exact: true }).click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { restoreInk: () => void }).restoreInk = () =>
      (IDBObjectStore.prototype.put = original);
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'ink') throw new DOMException('full', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await draw(
    page,
    [
      [0.2, 0.6],
      [0.8, 0.6],
    ],
    false,
  );
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await page.getByLabel('Dismiss error').click();
  await expect(page.getByRole('button', { name: 'Ink not saved · Retry ink' })).toBeVisible();
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
  await page.getByLabel('Back to library').click();
  await expect(page.locator('.reader-shell')).toBeVisible();
  await page.getByLabel('Dismiss error').click();
  await page.evaluate(() => (window as unknown as { restoreInk: () => void }).restoreInk());
  await page.getByRole('button', { name: 'Ink not saved · Retry ink' }).click();
  await expect(page.getByLabel('Undo ink')).toBeEnabled();
  await page.reload();
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
});

test('many handwritten annotations reopen without mounting the whole document', async ({
  page,
}) => {
  test.setTimeout(150000);
  await page.goto('/');
  await page
    .getByLabel('Import PDF file', { exact: true })
    .setInputFiles('tests/fixtures/large.pdf');
  await expect(page.locator('.pdf-page[data-page="1"][data-rendered="true"]')).toBeVisible();
  await page.getByLabel('Back to library').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  const path = await (await download).path();
  const b = JSON.parse(await readFile(path!, 'utf8'));
  const now = Date.now();
  b.strokes = Array.from({ length: 5000 }, (_, i) => ({
    version: 1,
    id: 'handwritten-' + i,
    rootId: 'handwritten-' + i,
    documentId: b.documents[0].id,
    page: i < 1000 ? 1 : 2 + (i % 80),
    kind: i % 5 ? 'pen' : 'marker',
    color: i % 5 ? '#2856b6' : '#f5d742',
    width: i % 5 ? 0.002 : 0.015,
    opacity: i % 5 ? 1 : 0.28,
    pageWidth: 612,
    pageHeight: 792,
    points: Array.from({ length: 12 }, (_, j) => ({
      x: 0.08 + (i % 40) * 0.02 + j * 0.001,
      y: 0.25 + Math.floor((i % 1000) / 40) * 0.018 + Math.sin(j) * 0.002,
      pressure: null,
    })),
    createdAt: now + i,
    updatedAt: now + i,
  }));
  const imported = Date.now();
  await page.getByLabel('Import annotation backup', { exact: true }).setInputFiles({
    name: 'handwriting.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(b)),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Restored 5000' })).toBeVisible({
    timeout: 90000,
  });
  const importMs = Date.now() - imported;
  const start = Date.now();
  await page.locator('.document-open').click();
  await expect(page.locator('.pdf-page[data-page="1"] [data-stroke]')).toHaveCount(1000);
  const reopenMs = Date.now() - start;
  await page.getByLabel('Page number', { exact: true }).fill('70');
  await page.getByLabel('Page number', { exact: true }).press('Enter');
  await expect(page.locator('.pdf-page[data-page="70"][data-rendered="true"]')).toBeVisible();
  expect(await page.locator('.ink-layer').count()).toBeLessThanOrEqual(9);
  expect(await page.locator('canvas').count()).toBeLessThanOrEqual(9);
  await page.getByLabel('Page number', { exact: true }).fill('1');
  await page.getByLabel('Page number', { exact: true }).press('Enter');
  await expect(page.locator('.pdf-page[data-page="1"] [data-stroke]')).toHaveCount(1000);
  await expect(page.locator('.reader-title span')).toHaveText('Saved on this device');
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] [data-stroke]')).toHaveCount(1000);
  console.log(
    'INK PERFORMANCE',
    JSON.stringify({
      strokes: 5000,
      densePageStrokes: 1000,
      points: 60000,
      importMs,
      reopenMs,
      maxLivePages: 9,
    }),
  );
  await writeFile(
    'test-results/ink-performance.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        environment: 'Chromium on Linux; synthetic 1,500-page PDF',
        strokes: 5000,
        densePageStrokes: 1000,
        points: 60000,
        importMs,
        reopenMs,
      },
      null,
      2,
    ),
  );
});

test('crop origins and intrinsic rotation keep ink aligned through further view rotation', async ({
  page,
}) => {
  await open(page, 'rotated.pdf');
  await page.getByLabel('Pen tool', { exact: true }).click();
  await draw(page, [
    [0.25, 0.4],
    [0.7, 0.6],
  ]);
  const original = await page.locator('.ink-layer [data-stroke]').getAttribute('d');
  const data = await backup(page);
  const s = data.strokes[0];
  expect(s.pageWidth).toBe(420);
  expect(s.pageHeight).toBe(600);
  expect(s.points[0].x).toBeCloseTo(0.4, 2);
  expect(s.points[0].y).toBeCloseTo(0.25, 2);
  await page.getByLabel('Close sidebar', { exact: true }).click();
  // Read both bounds in one browser task: sidebar resizing can otherwise happen
  // between two protocol round-trips and mix different viewport scales.
  const center = () =>
    page.evaluate(() => {
      const p = document.querySelector('.pdf-page')!.getBoundingClientRect();
      const b = document.querySelector('.ink-layer [data-stroke]')!.getBoundingClientRect();
      return { x: (b.x + b.width / 2 - p.x) / p.width, y: (b.y + b.height / 2 - p.y) / p.height };
    });
  const before = await center();
  await page.getByLabel('Rotate clockwise').click();
  await expect(page.locator('.pdf-page')).toHaveAttribute('data-rendered', 'true');
  await expect(page.locator('.textLayer')).toHaveAttribute('data-main-rotation', '180');
  const after = await center();
  expect(after.x).toBeCloseTo(1 - before.y, 2);
  expect(after.y).toBeCloseTo(before.x, 2);
  expect(await page.locator('.ink-layer [data-stroke]').getAttribute('d')).toBe(original);
  await page.reload();
  await expect(page.locator('.ink-layer [data-stroke]')).toHaveCount(1);
});

test('pen colors, widths and finger preferences are restored on reload', async ({ page }) => {
  await open(page);
  await page.getByLabel('Pen tool', { exact: true }).click();
  await page.getByLabel('Tool options').click();
  await page.getByLabel('Ink color #c3463f', { exact: true }).click();
  await page.getByLabel('Stroke width', { exact: true }).evaluate((e: HTMLInputElement) => {
    e.value = '7';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByLabel('Draw with a finger').check();
  await page.getByLabel('Smooth input').uncheck();
  await page.getByLabel('Tool options').click();
  await draw(page, [
    [0.2, 0.65],
    [0.8, 0.65],
  ]);
  const b = await backup(page);
  expect(b.strokes[0].color).toBe('#c3463f');
  expect(b.strokes[0].width * 612).toBeCloseTo(7, 2);
  await page.reload();
  await page.getByLabel('Tool options').click();
  await expect(page.getByLabel('Draw with a finger')).toBeChecked();
  await expect(page.getByLabel('Smooth input')).not.toBeChecked();
  await expect(page.getByLabel('Stroke width', { exact: true })).toHaveValue('7');
});

test('a long continuous gesture is saved in bounded vector chunks and undone as one stroke', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Pen tool', { exact: true }).click();
  const layer = page.locator('.ink-layer');
  const b = (await layer.boundingBox())!;
  await page.evaluate(() =>
    document
      .querySelector('.ink-layer')!
      .addEventListener(
        'pointerdown',
        (e) =>
          ((window as unknown as { activeInkPointer: number }).activeInkPointer = (
            e as PointerEvent
          ).pointerId),
      ),
  );
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.65);
  await page.mouse.down();
  await layer.evaluate((node, box) => {
    const pointerId = (window as unknown as { activeInkPointer: number }).activeInkPointer;
    for (let i = 0; i < 8300; i++)
      node.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId,
          pointerType: 'mouse',
          buttons: 1,
          button: -1,
          clientX: box.x + box.width * (i % 2 ? 0.25 : 0.75),
          clientY: box.y + box.height * 0.65,
        }),
      );
  }, b);
  await page.mouse.up();
  await expect(page.getByLabel('Undo ink')).toBeEnabled();
  await expect(layer.locator('[data-stroke]')).toHaveCount(2);
  await page.getByLabel('Undo ink').click();
  await expect(layer.locator('[data-stroke]')).toHaveCount(0);
  await page.getByLabel('Redo ink').click();
  await expect(layer.locator('[data-stroke]')).toHaveCount(2);
});
