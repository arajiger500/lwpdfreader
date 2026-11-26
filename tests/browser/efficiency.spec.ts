import { expect, test } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

interface Samples {
  frames: number[];
  inkUpdates: number[];
  longTasks: number[];
  renders: number;
  writes: Record<string, number>;
  stop?: () => void;
}

test('opt-in efficiency proxies for reader lifecycle, gestures and ink', async ({
  page,
  browser,
  browserName,
}) => {
  test.skip(!process.env.LWPDF_EFFICIENCY || browserName !== 'chromium');
  test.setTimeout(150000);
  const fixture = process.env.LWPDF_BENCHMARK_FILE ?? 'large.pdf';
  await page.addInitScript(() => {
    const measurements: Samples = {
      frames: [],
      inkUpdates: [],
      longTasks: [],
      renders: 0,
      writes: {},
    };
    Object.assign(window, { measurements });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) measurements.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
    document.addEventListener('page-rendered', () => {
      measurements.renders++;
    });
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      const tx = transaction.call(
        this,
        typeof names === 'string' ? names : [...names],
        mode,
        options,
      );
      const stores = typeof names === 'string' ? [names] : names;
      if (mode === 'readwrite') {
        tx.addEventListener('complete', () => {
          for (const key of stores) measurements.writes[key] = (measurements.writes[key] ?? 0) + 1;
        });
      }
      return tx;
    };
  });
  const metrics = () =>
    page.evaluate(() => {
      const state = (window as unknown as { measurements: Samples }).measurements;
      return {
        ...state,
        stop: undefined,
        canvasPixels: [...document.querySelectorAll('canvas')].reduce(
          (n, c) => n + c.width * c.height,
          0,
        ),
        heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize,
      };
    });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const system = await browser.newBrowserCDPSession();
  const start = performance.now();
  await page.goto('/');
  await expect(page.getByLabel('Import PDF file')).toBeAttached();
  const startupMs = performance.now() - start;
  const ready = page.locator('.pdf-page[data-page="1"][data-rendered="true"]');
  const importing = performance.now();
  await page.getByLabel('Import PDF file').setInputFiles('tests/fixtures/' + fixture);
  await expect(ready).toBeVisible({ timeout: 30000 });
  const importMs = performance.now() - importing;

  const processSnapshot = async () => {
    const { processInfo } = await system.send('SystemInfo.getProcessInfo');
    return Promise.all(
      processInfo.map(async ({ id, type, cpuTime }) => ({
        id,
        type,
        cpuTime,
        rss:
          Number(
            (await readFile('/proc/' + id + '/status', 'utf8').catch(() => '')).match(
              /^VmRSS:\s+(\d+)/m,
            )?.[1] ?? 0,
          ) * 1024,
      })),
    );
  };
  const workerTargets = async () =>
    (await system.send('Target.getTargets', { filter: [{ type: 'worker' }] })).targetInfos.filter(
      (target) => target.url.includes('pdf.worker'),
    );
  async function workerMemory() {
    const workers = await workerTargets();
    return Promise.all(
      workers.map(async ({ targetId }) => {
        let sessionId: string | undefined;
        try {
          sessionId = (await system.send('Target.attachToTarget', { targetId, flatten: false }))
            .sessionId;
          const heap = await new Promise<unknown>((resolve) => {
            const timer = setTimeout(() => done(null), 750);
            const receive = (event: { sessionId: string; message: string }) => {
              if (event.sessionId !== sessionId) return;
              const message = JSON.parse(event.message);
              if (message.id === 1) done(message.result ?? null);
            };
            function done(result: unknown) {
              clearTimeout(timer);
              system.off('Target.receivedMessageFromTarget', receive);
              resolve(result);
            }
            system.on('Target.receivedMessageFromTarget', receive);
            void system
              .send('Target.sendMessageToTarget', {
                sessionId,
                message: JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }),
              })
              .catch(() => done(null));
          });
          return { targetId, heap };
        } catch {
          return { targetId, heap: null };
        } finally {
          if (sessionId)
            await system.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        }
      }),
    );
  }
  const taskDuration = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find(
      (metric) => metric.name === 'TaskDuration',
    )?.value;
  const cycles = [];
  for (let i = 0; i < 6; i++) {
    await page.getByLabel('Back to library').click();
    await expect(page.locator('.document-open')).toBeVisible();
    const closed = await processSnapshot();
    const closedWorkerCount = (await workerTargets()).length;
    const begin = performance.now();
    await page.locator('.document-open').click();
    await expect(ready).toBeVisible({ timeout: 30000 });
    cycles.push({
      reopenMs: performance.now() - begin,
      closed,
      closedWorkerCount,
      opened: await processSnapshot(),
      openWorkerCount: (await workerTargets()).length,
    });
  }
  await page.getByLabel('Reading mode').selectOption('single');
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await page.waitForTimeout(1250);
  const mainHeap = await cdp.send('Runtime.getHeapUsage');
  const pdfWorkerHeaps = await workerMemory();
  const inputCapabilities = await page.evaluate(() => ({
    coalescedEvents: 'getCoalescedEvents' in PointerEvent.prototype,
    predictedEvents: 'getPredictedEvents' in PointerEvent.prototype,
  }));
  const idleStart = {
    display: await metrics(),
    taskSeconds: await taskDuration(),
    processes: await processSnapshot(),
  };
  await page.waitForTimeout(1500);
  const idleEnd = {
    display: await metrics(),
    taskSeconds: await taskDuration(),
    processes: await processSnapshot(),
  };

  await page.getByRole('button', { name: 'Pen tool', exact: true }).click();
  await expect(page.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
  await page.evaluate(() => {
    const state = (window as unknown as { measurements: Samples }).measurements;
    const surface = document.querySelector('.viewer')!;
    let lastPointer = 0;
    const pointer = () => {
      lastPointer = performance.now();
    };
    surface.addEventListener('pointermove', pointer, true);
    const observer = new MutationObserver(() => {
      if (lastPointer) {
        state.inkUpdates.push(performance.now() - lastPointer);
        lastPointer = 0;
      }
    });
    const draft = document.querySelector('.ink-layer path')!;
    observer.observe(draft, { attributes: true, attributeFilter: ['d'] });
    state.stop = () => {
      observer.disconnect();
      surface.removeEventListener('pointermove', pointer, true);
    };
  });
  const sendPen = (
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    x: number,
    y: number,
    force: number,
  ) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      pointerType: 'pen',
      force,
    });
  const inkBefore = await metrics();
  await sendPen('mousePressed', 410, 330, 0.4);
  for (let i = 1; i <= 60; i++)
    await sendPen(
      'mouseMoved',
      410 + i * 5,
      330 + Math.sin(i / 5) * 25,
      0.5 + Math.sin(i / 8) * 0.3,
    );
  await sendPen('mouseReleased', 710, 330 + Math.sin(12) * 25, 0);
  await expect(page.getByLabel('Undo ink')).toBeEnabled();
  const inkAfter = await metrics();
  await page.evaluate(() => (window as unknown as { measurements: Samples }).measurements.stop?.());

  await page.evaluate(() => {
    const state = (window as unknown as { measurements: Samples }).measurements;
    let previous = 0,
      frame = 0;
    const sample = (time: number) => {
      if (previous) state.frames.push(time - previous);
      previous = time;
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    state.stop = () => cancelAnimationFrame(frame);
  });
  const zoomBefore = await metrics();
  const points = (i: number) => [
    { id: 1, x: 505 - i * 2, y: 400 - i },
    { id: 2, x: 675 + i, y: 400 - i },
  ];
  const widthBefore = (await ready.boundingBox())?.width;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
  for (let i = 1; i <= 30; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(i) });
  const zoomActive = await metrics();
  const release = performance.now();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => (window as unknown as { measurements: Samples }).measurements.stop?.());
  await expect(ready).toBeVisible();
  const widthAfter = (await ready.boundingBox())?.width;
  const zoomAfter = await metrics();
  const settledMs = widthBefore !== widthAfter ? performance.now() - release : null;

  const files = await readdir('dist/assets');
  const bundle = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile('dist/assets/' + file);
      return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    }),
  );
  const cache = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    let entries = 0,
      bytes = 0;
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response) {
          entries++;
          bytes += (await response.arrayBuffer()).byteLength;
        }
      }
    }
    return { entries, bytes };
  });
  await writeFile(
    test.info().outputPath('efficiency.json'),
    JSON.stringify(
      {
        fixture,
        browser: browser.version(),
        date: new Date().toISOString(),
        startupMs,
        importMs,
        cycles,
        idleStart,
        idleEnd,
        inkBefore,
        inkAfter,
        zoomBefore,
        zoomActive,
        zoomAfter,
        settledMs,
        mainHeap,
        pdfWorkerHeaps,
        inputCapabilities,
        widthBefore,
        widthAfter,
        bundle,
        cache,
      },
      null,
      2,
    ),
  );
});

test('opt-in sustained reading and handwriting on an illustrated textbook', async ({
  page,
  browser,
  browserName,
}) => {
  const duration = Number(process.env.LWPDF_SUSTAINED_MS ?? 0);
  test.skip(!duration || browserName !== 'chromium');
  test.setTimeout(duration + 90000);
  const fixture = process.env.LWPDF_BENCHMARK_FILE ?? 'heavy.pdf';
  await page.goto('/');
  await page.getByLabel('Import PDF file').setInputFiles('tests/fixtures/' + fixture);
  const ready = page.locator('.pdf-page[data-page="1"][data-rendered="true"]');
  await expect(ready).toBeVisible({ timeout: 45000 });
  await page.getByLabel('Reading mode').selectOption('single');
  await page.getByLabel('Page fit').selectOption('page');
  await page.getByRole('button', { name: 'Pen tool', exact: true }).click();
  const cdp = await browser.newBrowserCDPSession();
  const rows = [];
  const start = performance.now();
  let written = 0;
  let navigated = 0;
  let lastSample = 0;
  while (performance.now() - start < duration) {
    const next = ((navigated * 173 + 91) % 1499) + 1;
    const target = page.getByLabel('Page number', { exact: true });
    await target.fill(String(next));
    await target.press('Enter');
    const active = page.locator(`.pdf-page[data-page="${next}"][data-rendered="true"]`);
    await expect(active).toBeVisible();
    await expect(active.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
    navigated++;
    const bounds = (await active.boundingBox())!;
    const x = bounds.x + bounds.width * 0.2;
    const y = bounds.y + bounds.height * 0.5;
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(x, y + i * 15);
      await page.mouse.down();
      await page.mouse.move(x + bounds.width * 0.45, y + i * 15 + 7, { steps: 5 });
      await page.mouse.up();
      written++;
    }
    await expect(page.getByLabel('Undo ink')).toBeEnabled();
    if (performance.now() - lastSample >= 12000) {
      lastSample = performance.now();
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const processes = await Promise.all(
        processInfo.map(async ({ id, type, cpuTime }) => ({
          id,
          type,
          cpuTime,
          rss:
            Number(
              (await readFile('/proc/' + id + '/status', 'utf8').catch(() => '')).match(
                /^VmRSS:\s+(\d+)/m,
              )?.[1] ?? 0,
            ) * 1024,
        })),
      );
      rows.push({
        elapsedMs: lastSample - start,
        navigated,
        written,
        processes,
        application: await page.evaluate(() => ({
          canvases: document.querySelectorAll('.pdf-page canvas').length,
          pixels: [...document.querySelectorAll('.pdf-page canvas')].reduce((total, canvas) => {
            const image = canvas as HTMLCanvasElement;
            return total + image.width * image.height;
          }, 0),
          mainHeap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize,
        })),
      });
    }
  }
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.locator('.document-open').click();
  await expect(page.locator('[data-stroke]')).toHaveCount(3);
  await writeFile(
    test.info().outputPath('sustained.json'),
    JSON.stringify(
      {
        fixture,
        duration,
        browser: browser.version(),
        written,
        navigated,
        rows,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
});
