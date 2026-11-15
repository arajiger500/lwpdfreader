import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
async function importPdf(page: Page, file = 'study.pdf') {
  await page.goto('/');
  await page.getByLabel('Import PDF file', { exact: true }).setInputFiles('tests/fixtures/' + file);
  await expect(page.locator('.pdf-page[data-page="1"][data-rendered="true"]')).toBeVisible({
    timeout: 120000,
  });
}
async function jump(page: Page, n: number) {
  await page.getByLabel('Page number', { exact: true }).fill(String(n));
  await page.getByLabel('Page number', { exact: true }).press('Enter');
  await expect(page.locator(`.pdf-page[data-page="${n}"][data-rendered="true"]`)).toBeVisible();
}
async function selectText(page: Page) {
  const span = page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .filter({ hasText: 'Biology is the study of life.' })
    .first();
  await expect(span).toBeVisible();
  const b = await span.boundingBox();
  if (!b) throw new Error('No text layer');
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('toolbar', { name: 'Highlight selected text' })).toBeVisible();
}
test('real PDF reading, annotation persistence, backups and offline launch', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importPdf(page);
  await page.getByLabel('Next page', { exact: true }).click();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('2');
  await jump(page, 10);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('10');
  await jump(page, 1);
  await selectText(page);
  await page.getByLabel('Highlight yellow', { exact: true }).click();
  await expect(page.locator('.pdf-page[data-page="1"] .highlight')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] .highlight')).toHaveCount(1);
  await page.getByLabel('Toggle document sidebar').click();
  await page.locator('.annotation-item').first().click();
  await page.getByLabel('Change highlight to green').click();
  await expect(page.locator('.highlight.green')).toHaveCount(1);
  await page.getByLabel('Your note', { exact: true }).fill('Remember the definition of biology.');
  await expect(page.getByLabel('Retry saving note')).toHaveText('Saved');
  await page.getByLabel('Close sidebar', { exact: true }).click();
  await page.getByLabel('Bookmark page', { exact: true }).click();
  await page.getByLabel('Add page note', { exact: true }).click();
  await page.getByLabel('Your note', { exact: true }).fill('A page-level study note.');
  await expect(page.getByLabel('Retry saving note')).toHaveText('Saved');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export document backup' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const backup = JSON.parse(await readFile(path!, 'utf8'));
  expect(backup.annotations).toHaveLength(3);
  await page.reload();
  await page.getByLabel('Toggle document sidebar').click();
  await expect(page.locator('.annotation-item')).toHaveCount(2);
  await expect(page.locator('.sidebar')).toContainText('A page-level study note.');
  await page.locator('.annotation-item').filter({ hasText: 'Biology' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.highlight')).toHaveCount(0);
  await page.getByLabel('Back to library').click();
  await page.getByLabel('Import annotation backup', { exact: true }).setInputFiles({
    name: 'restore.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  await page.locator('.document-open').click();
  await expect(page.locator('.highlight.green')).toHaveCount(1);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"][data-rendered="true"]')).toBeVisible();
  await expect(page.locator('.highlight.green')).toHaveCount(1);
  await jump(page, 12);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});
test('corrupt imports fail clearly without adding a library entry', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Import PDF file', { exact: true })
    .setInputFiles('tests/fixtures/broken.pdf');
  await expect(page.getByRole('alert')).toContainText('Could not open this PDF');
  await expect(page.locator('.document-row')).toHaveCount(0);
});
test('large PDF benchmark: bounded canvases and distant navigation', async ({ page }) => {
  test.setTimeout(180000);
  const fixture = process.env.LWPDF_BENCHMARK_FILE ?? 'large.pdf';
  const begin = Date.now();
  await importPdf(page, fixture);
  const firstPage = Date.now() - begin;
  await page.getByLabel('Back to library').click();
  const reopenStart = Date.now();
  await page.locator('.document-open').click();
  await expect(page.locator('.pdf-page[data-page="1"][data-rendered="true"]')).toBeVisible();
  const reopenMs = Date.now() - reopenStart;
  const destinations = [
    1000,
    25,
    1490,
    700,
    1,
    1200,
    40,
    1450,
    ...Array.from({ length: 32 }, (_, i) => ((i * 173 + 91) % 1499) + 1),
  ];
  const cdp = await page.context().browser()!.newBrowserCDPSession();
  async function browserRss() {
    if (process.platform !== 'linux') return null;
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const values = await Promise.all(
      processInfo.map(async (p) => {
        try {
          const status = await readFile(`/proc/${p.id}/status`, 'utf8');
          return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
        } catch {
          return 0;
        }
      }),
    );
    return values.reduce((sum, n) => sum + n, 0);
  }
  const samples: {
    page: number;
    navigationMs: number;
    canvases: number;
    heap: number | null;
    browserRssBytes: number | null;
  }[] = [];
  for (const n of destinations) {
    const start = Date.now();
    await jump(page, n);
    samples.push({
      page: n,
      navigationMs: Date.now() - start,
      canvases: await page.locator('.pdf-page canvas').count(),
      browserRssBytes: await browserRss(),
      heap: await page.evaluate(
        () =>
          (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? null,
      ),
    });
    expect(samples.at(-1)!.canvases).toBeLessThanOrEqual(9);
  }
  const z = Date.now();
  await page.getByLabel('Zoom in', { exact: true }).click();
  await expect(
    page.locator(`.pdf-page[data-page="${destinations.at(-1)}"][data-rendered="true"]`),
  ).toBeVisible();
  const zoomMs = Date.now() - z;
  await page.getByLabel('Back to library').click();
  await page.waitForTimeout(1000);
  const closedBrowserRssBytes = await browserRss();
  await cdp.detach();
  const report = {
    date: new Date().toISOString(),
    browser: 'Chromium on Linux; original synthetic PDF, not real iPad hardware',
    pages: 1500,
    fixture,
    fixtureBytes: (await readFile('tests/fixtures/' + fixture)).length,
    firstPageMs: firstPage,
    reopenMs,
    zoomMs,
    closedBrowserRssBytes,
    samples,
  };
  await writeFile(
    'test-results/performance-' + fixture.replace('.pdf', '') + '.json',
    JSON.stringify(report, null, 2),
  );
  console.log('PERFORMANCE', JSON.stringify(report));
});
test('mixed dimensions, multiline highlights, rotation, region and session settings', async ({
  page,
}) => {
  await importPdf(page);
  await page.getByLabel('Reading mode').selectOption('single');
  await page.getByLabel('Page fit').selectOption('page');
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await page.locator('.pdf-page[data-rendered="true"]').waitFor();
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')];
    const start = spans.find((e) => e.textContent?.includes('Biology'));
    const end = spans.find((e) => e.textContent?.includes('fundamental'));
    const range = document.createRange();
    range.setStart(start!.firstChild!, 0);
    range.setEnd(end!.firstChild!, end!.textContent!.length);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByLabel('Highlight blue', { exact: true }).click();
  await expect(page.locator('.highlight.blue')).toHaveCount(2);
  const checkAlignment = async () => {
    const result = await page.evaluate(() => {
      const spans = [
        ...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span'),
      ].filter((e) => e.textContent?.includes('Biology') || e.textContent?.includes('fundamental'));
      const rects = [...document.querySelectorAll('.highlight.blue')].map((e) =>
        e.getBoundingClientRect(),
      );
      return spans.map((s) => {
        const r = s.getBoundingClientRect();
        return Math.min(
          ...rects.map(
            (h) =>
              Math.abs(h.left - r.left) +
              Math.abs(h.top - r.top) +
              Math.abs(h.width - r.width) +
              Math.abs(h.height - r.height),
          ),
        );
      });
    });
    for (const diff of result) expect(diff).toBeLessThan(7);
  };
  await checkAlignment();
  await page.getByLabel('Zoom in', { exact: true }).click();
  await expect(page.locator('.pdf-page[data-rendered="true"]')).toBeVisible();
  await checkAlignment();
  await page.getByLabel('Rotate clockwise').click();
  await expect(page.locator('.pdf-page[data-rendered="true"]')).toBeVisible();
  await checkAlignment();
  await jump(page, 3);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3');
  await page.getByLabel('Region highlight', { exact: true }).click();
  const bounds = await page.locator('.pdf-page[data-page="3"]').boundingBox();
  if (!bounds) throw new Error('No page');
  await page.mouse.move(bounds.x + 80, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180, bounds.y + 150, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.pdf-page[data-page="3"] .highlight')).toHaveCount(1);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Reading mode')).toHaveValue('single');
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await expect(page.locator('.highlight')).toHaveCount(1);
  await page.getByLabel('Back to library').click();
  await page
    .getByLabel('Import PDF file', { exact: true })
    .setInputFiles('tests/fixtures/study.pdf');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3');
  await page.getByLabel('Back to library').click();
  await expect(page.locator('.document-row')).toHaveCount(1);
});
test('5,000 annotations: validated restore, bounded sidebar and page lookup', async ({ page }) => {
  test.setTimeout(120000);
  await importPdf(page, 'large.pdf');
  await page.getByLabel('Back to library').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  const file = await (await downloadPromise).path();
  const b = JSON.parse(await readFile(file!, 'utf8'));
  const now = Date.now();
  b.annotations = Array.from({ length: 5000 }, (_, i) => ({
    version: 1,
    id: 'bench-' + i,
    documentId: b.documents[0].id,
    page: (i % 1000) + 1,
    kind: 'highlight',
    color: 'yellow',
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
    text: 'Synthetic study annotation ' + i,
    note: '',
    createdAt: now,
    updatedAt: now,
  }));
  const start = Date.now();
  await page.getByLabel('Import annotation backup', { exact: true }).setInputFiles({
    name: 'many.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(b)),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Restored 5000' })).toBeVisible();
  const importMs = Date.now() - start;
  const opened = Date.now();
  await page.locator('.document-open').click();
  await expect(page.locator('.pdf-page[data-page="1"][data-rendered="true"]')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="1"] .highlight')).toHaveCount(5);
  const reopenMs = Date.now() - opened;
  const jumpStart = Date.now();
  await jump(page, 1000);
  const navigationMs = Date.now() - jumpStart;
  await expect(page.locator('.pdf-page[data-page="1000"] .highlight')).toHaveCount(5);
  await page.getByLabel('Toggle document sidebar').click();
  await expect(page.locator('.annotation-item')).toHaveCount(200);
  await expect(page.getByRole('button', { name: 'Show more (4800 remaining)' })).toBeVisible();
  const report = {
    date: new Date().toISOString(),
    environment: 'Chromium on Linux, 1,500-page vector fixture',
    annotations: 5000,
    backupBytes: Buffer.byteLength(JSON.stringify(b)),
    importMs,
    reopenMs,
    distantNavigationMs: navigationMs,
    sidebarMountedItems: 200,
  };
  await writeFile('test-results/annotations.json', JSON.stringify(report, null, 2));
  console.log('ANNOTATIONS', JSON.stringify(report));
});
test('failed annotation writes stay visibly unsaved and can be retried', async ({ page }) => {
  await importPdf(page);
  await selectText(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { restoreWrites: () => void }).restoreWrites = () =>
      (IDBObjectStore.prototype.put = original);
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'annotations')
        throw new DOMException('Test quota failure', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.getByLabel('Highlight yellow', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await expect(page.locator('.highlight')).toHaveCount(0);
  await expect(page.getByLabel('Highlight yellow', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { restoreWrites: () => void }).restoreWrites());
  await page.getByLabel('Dismiss error').click();
  await page.getByLabel('Highlight yellow', { exact: true }).click();
  await expect(page.locator('.highlight')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.highlight')).toHaveCount(1);
});

test('page-relative resume survives reload and explicit library reopen', async ({ page }) => {
  await importPdf(page);
  await jump(page, 6);
  await page.evaluate(() => {
    const viewer = document.querySelector<HTMLElement>('.viewer')!;
    const pdfPage = document.querySelector<HTMLElement>('.pdf-page[data-page="6"]')!;
    viewer.scrollTop = pdfPage.offsetTop - 10 + pdfPage.offsetHeight * 0.4;
  });
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('6');
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="6"][data-rendered="true"]')).toBeVisible();
  const offset = await page.evaluate(() => {
    const viewer = document.querySelector<HTMLElement>('.viewer')!;
    const pdfPage = document.querySelector<HTMLElement>('.pdf-page[data-page="6"]')!;
    return (viewer.scrollTop - (pdfPage.offsetTop - 10)) / pdfPage.offsetHeight;
  });
  expect(offset).toBeCloseTo(0.4, 1);
  await page.getByLabel('Back to library').click();
  await page.locator('.document-open').click();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('6');
  await page.getByLabel('Back to library').click();
  await page.getByLabel('Remove study.pdf', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove document', exact: true }).click();
  await expect(page.locator('.document-row')).toHaveCount(0);
});

test('an unsaved note cannot be discarded by closing the sidebar or leaving the reader', async ({
  page,
}) => {
  await importPdf(page);
  await page.getByLabel('Add page note', { exact: true }).click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { restoreWrites: () => void }).restoreWrites = () =>
      (IDBObjectStore.prototype.put = original);
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'annotations') throw new DOMException('Test failure', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.getByLabel('Your note', { exact: true }).fill('Keep this unsaved thought safe.');
  await expect(page.getByLabel('Retry saving note')).toHaveText('Not saved — retry');
  await page.getByLabel('Dismiss error').click();
  await page.getByLabel('Close sidebar', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await expect(page.getByLabel('Your note', { exact: true })).toHaveValue(
    'Keep this unsaved thought safe.',
  );
  await page.getByLabel('Dismiss error').click();
  await page.getByLabel('Back to library').click();
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await expect(page.getByLabel('Your note', { exact: true })).toHaveValue(
    'Keep this unsaved thought safe.',
  );
  await page.evaluate(() => (window as unknown as { restoreWrites: () => void }).restoreWrites());
  await page.getByLabel('Dismiss error').click();
  await page.getByLabel('Back to library').click();
  await page.locator('.document-open').click();
  await page.getByLabel('Toggle document sidebar').click();
  await expect(page.locator('.sidebar')).toContainText('Keep this unsaved thought safe.');
});

test('fit width keeps mixed-size pages within the portrait viewport', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await importPdf(page);
  await expect(page.locator('.pdf-page[data-page="3"]')).toHaveAttribute('data-rendered', 'true');
  const fits = async (n: number) => {
    const bounds = await page.locator(`.pdf-page[data-page="${n}"]`).boundingBox();
    const viewer = await page.locator('.viewer').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(viewer!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewer!.x + viewer!.width + 1);
  };
  await fits(1);
  await fits(3);
  await jump(page, 3);
  await fits(3);
  await page.getByLabel('Rotate clockwise').click();
  await expect(page.locator('.pdf-page[data-page="3"]')).toHaveAttribute('data-rendered', 'true');
  await fits(3);
});
