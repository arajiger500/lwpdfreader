import { expect, test, type Page } from './browser-fixtures';

async function open(page: Page, fixture = 'study.pdf') {
  await page.goto('/');
  const input = page.getByLabel('Import PDF file');
  await input.setInputFiles('tests/fixtures/' + fixture);
  await expect(page.locator('.pdf-page[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
  await page.getByLabel('Reading mode').selectOption('single');
  await expect(page.locator('.pdf-page')).toHaveCount(1);
}

async function attachAt(page: Page, x: number, y: number) {
  await page.getByRole('button', { name: 'Attach whiteboard', exact: true }).click();
  await page.locator('.pdf-page').click({ position: { x, y } });
  await expect(page.getByRole('dialog', { name: 'Attach whiteboard' })).toBeVisible();
}

const tools = [
  'Pen tool',
  'Freehand highlighter tool',
  'Eraser tool',
  'Hand tool',
  'Text highlight tool',
];
for (const tool of tools) {
  test('pinch and pan preserve ' + tool, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native multitouch injection uses Chromium CDP');
    await open(page);
    await page.getByLabel('Page fit').selectOption('width');
    const pdf = page.locator('.pdf-page');
    await expect(pdf).toHaveAttribute('data-rendered', 'true');
    await expect(page.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
    await page.getByRole('button', { name: tool, exact: true }).click();
    await page.getByLabel('Tool options').click();
    await page.getByLabel('Draw with a finger').check();
    await page.getByLabel('Tool options').click();
    const before = (await pdf.boundingBox())!;
    const center = { x: 590, y: 400 };
    const cdp = await page.context().newCDPSession(page);
    const left = { id: 1, x: center.x - 85, y: center.y };
    const right = { id: 2, x: center.x + 85, y: center.y };
    await page.evaluate(() => {
      const surface = document.querySelector('.viewer')!;
      surface.setAttribute('data-measured-renders', '0');
      surface.addEventListener('page-rendered', () => {
        surface.setAttribute(
          'data-measured-renders',
          String(1 + Number(surface.getAttribute('data-measured-renders'))),
        );
      });
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left, right] });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { ...left, x: left.x - 55, y: left.y - 40 },
        { ...right, x: right.x + 15, y: right.y - 40 },
      ],
    });
    await expect
      .poll(async () => (await pdf.boundingBox())!.width)
      .toBeGreaterThan(before.width * 1.3);
    await expect(page.locator('.viewer')).toHaveAttribute('data-measured-renders', '0');
    await expect(pdf.locator('canvas')).toHaveCount(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.viewer')).toHaveAttribute('data-measured-renders', '1');
    const after = (await pdf.boundingBox())!;
    const pageX = (center.x - before.x) / before.width;
    const pageY = (center.y - before.y) / before.height;
    expect(Math.abs(after.x + pageX * after.width - (center.x - 20))).toBeLessThan(4);
    expect(Math.abs(after.y + pageY * after.height - (center.y - 40))).toBeLessThan(4);
    await expect(page.getByRole('button', { name: tool, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('[data-stroke]')).toHaveCount(0);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left, right] });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { ...left, x: left.x - 25, y: left.y - 35 },
        { ...right, x: right.x - 25, y: right.y - 35 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await pdf.boundingBox())!.y).toBeLessThan(after.y - 30);
    const panned = (await pdf.boundingBox())!;
    expect(Math.abs(panned.x - (after.x - 25))).toBeLessThan(4);
    expect(Math.abs(panned.width - after.width)).toBeLessThan(1);
    await expect(page.locator('.viewer')).toHaveAttribute('data-measured-renders', '1');
    await expect(page.locator('[data-stroke]')).toHaveCount(0);
    await cdp.detach();
  });
}

test('touch cancellation drains an ambiguous drawing gesture', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native multitouch injection uses Chromium CDP');
  await open(page);
  await page.getByLabel('Pen tool', { exact: true }).click();
  await page.getByLabel('Tool options').click();
  await page.getByLabel('Draw with a finger').check();
  await page.getByLabel('Tool options').click();
  const cdp = await page.context().newCDPSession(page);
  const one = { id: 1, x: 500, y: 400 };
  const two = { id: 2, x: 660, y: 400 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [one] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...one, x: 520 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...one, x: 520 }, two],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('[data-stroke]')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [one] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...one, x: 560 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('[data-stroke]')).toHaveCount(1);
  await cdp.detach();
});

test('whiteboard editing, shared anchors, exact return, rotation and reload', async ({ page }) => {
  await open(page, 'rotated.pdf');
  await page.getByLabel('Page fit').selectOption('page');
  const pdf = page.locator('.pdf-page');
  await expect(pdf).toHaveAttribute('data-rendered', 'true');
  const initial = (await pdf.boundingBox())!;
  await attachAt(page, initial.width * 0.25, initial.height * 0.3);
  await page.getByLabel('Title', { exact: true }).fill('Metabolism notes');
  await page.getByRole('button', { name: 'Create whiteboard' }).click();
  const board = page.getByRole('dialog', { name: 'Whiteboard', exact: true });
  await expect(board).toBeVisible();
  await expect(board.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
  await board.getByLabel('Whiteboard title').fill('Metabolic pathways');
  await board.getByLabel('Whiteboard background').selectOption('dotted');
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(650, 390, { steps: 24 });
  await page.mouse.up();
  await expect(board.getByRole('button', { name: 'Undo ink' })).toBeEnabled();
  await expect(board.locator('[data-stroke]')).toHaveCount(1);
  await board.getByRole('button', { name: 'Undo ink' }).click();
  await expect(board.locator('[data-stroke]')).toHaveCount(0);
  await board.getByRole('button', { name: 'Redo ink' }).click();
  await expect(board.locator('[data-stroke]')).toHaveCount(1);
  page.once('dialog', (confirmation) => confirmation.accept());
  await board.getByText('Actions', { exact: true }).click();
  await board.getByRole('button', { name: 'Clear whiteboard' }).click();
  await expect(board.locator('[data-stroke]')).toHaveCount(0);
  await board.getByRole('button', { name: 'Undo ink' }).click();
  await expect(board.locator('[data-stroke]')).toHaveCount(1);
  await board.getByRole('button', { name: 'Back to PDF' }).click();
  await expect(board).toHaveCount(0);
  expect(await pdf.boundingBox()).toEqual(initial);

  const marker = pdf.getByRole('button', { name: 'Open whiteboard: Metabolic pathways' });
  const original = (await marker.boundingBox())!;
  await page.getByLabel('Rotate clockwise').click();
  await expect(pdf).toHaveAttribute('data-rendered', 'true');
  const rotated = (await pdf.boundingBox())!;
  const position = (await marker.boundingBox())!;
  const newX = (position.x + position.width / 2 - rotated.x) / rotated.width;
  const newY = (position.y + position.height / 2 - rotated.y) / rotated.height;
  expect(newX).toBeCloseTo(0.7, 1);
  expect(newY).toBeCloseTo(0.25, 1);
  expect(position).not.toEqual(original);

  await attachAt(page, rotated.width * 0.8, rotated.height * 0.7);
  await page
    .getByRole('dialog', { name: 'Attach whiteboard' })
    .getByLabel('Whiteboard')
    .selectOption({ label: 'Metabolic pathways' });
  await page.getByRole('button', { name: 'Link whiteboard' }).click();
  await expect(board.locator('[data-stroke]')).toHaveCount(1);
  await board.getByRole('button', { name: 'Back to PDF' }).click();
  await expect(marker).toHaveCount(2);
  await page.reload();
  await expect(marker).toHaveCount(2);
  await marker.first().click();
  await expect(board.getByLabel('Whiteboard background')).toHaveValue('dotted');
  await expect(board.locator('[data-stroke]')).toHaveCount(1);
  await board.getByText('Actions', { exact: true }).click();
  await board.getByRole('button', { name: 'Unlink from this point' }).click();
  await expect(marker).toHaveCount(1);
  await marker.click();
  await expect(board.locator('[data-stroke]')).toHaveCount(1);
  page.once('dialog', (confirmation) => confirmation.accept());
  await board.getByText('Actions', { exact: true }).click();
  await board.getByRole('button', { name: 'Delete whiteboard' }).click();
  await expect(marker).toHaveCount(0);
});

test('whiteboard editor opens for the first time offline', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Uses Chromium service worker offline emulation');
  await open(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.pdf-page[data-rendered="true"]')).toBeVisible();
  await attachAt(page, 220, 240);
  await page.getByRole('button', { name: 'Create whiteboard' }).click();
  const board = page.getByRole('dialog', { name: 'Whiteboard', exact: true });
  await expect(board.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
  await board.getByRole('button', { name: 'Back to PDF' }).click();
  await expect(page.getByRole('button', { name: 'Open whiteboard: Whiteboard' })).toBeVisible();
});

test('losing surface capture during a pinch leaves the next input usable', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Native multitouch injection uses Chromium CDP');
  await open(page);
  await page.getByRole('button', { name: 'Pen tool', exact: true }).click();
  const viewer = page.locator('.viewer');
  await viewer.evaluate((el) => {
    el.addEventListener(
      'pointerdown',
      (event) => {
        const pointer = event as PointerEvent;
        if (pointer.pointerType === 'touch')
          el.setAttribute('data-last-pointer', String(pointer.pointerId));
      },
      true,
    );
  });
  const cdp = await page.context().newCDPSession(page);
  const touches = [
    { id: 1, x: 520, y: 400 },
    { id: 2, x: 650, y: 400 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches });
  const last = Number(await viewer.getAttribute('data-last-pointer'));
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { ...touches[0], x: 480 },
      { ...touches[1], x: 690 },
    ],
  });
  await viewer.evaluate((el, pointer) => el.releasePointerCapture(pointer), last);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { ...touches[0], x: 479 },
      { ...touches[1], x: 690 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.pdf-page')).toHaveAttribute('data-rendered', 'true');
  await expect(page.locator('[data-stroke]')).toHaveCount(0);
  await page.mouse.move(490, 350);
  await page.mouse.down();
  await page.mouse.move(610, 390, { steps: 15 });
  await page.mouse.up();
  await expect(page.locator('[data-stroke]')).toHaveCount(1);
  await cdp.detach();
});

test('dense whiteboard mounts only nearby geometry and pans with the drawing tool selected', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Native multitouch injection uses Chromium CDP');
  await open(page);
  await attachAt(page, 220, 240);
  await page.getByRole('button', { name: 'Create whiteboard' }).click();
  const board = page.getByRole('dialog', { name: 'Whiteboard', exact: true });
  await board.getByRole('button', { name: 'Back to PDF' }).click();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lwpdfreader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = db.transaction('whiteboards').objectStore('whiteboards').getAllKeys();
    const id = await new Promise<IDBValidKey>((resolve) => {
      read.onsuccess = () => resolve(read.result[0]);
    });
    const tx = db.transaction('ink', 'readwrite');
    for (let n = 0; n < 5000; n++) {
      const x = n < 500 ? 15730 + (n % 100) * 12 : 21000 + (n % 100) * 20;
      const y = n < 500 ? 16060 + Math.floor(n / 100) * 95 : 22000 + Math.floor(n / 100) * 70;
      tx.objectStore('ink').put({
        version: 1,
        id: 'fixture-' + n,
        rootId: 'fixture-' + n,
        documentId: 'whiteboard:' + id,
        page: 1,
        kind: 'pen',
        color: '#222222',
        width: 2.2 / 32768,
        opacity: 1,
        pageWidth: 32768,
        pageHeight: 32768,
        createdAt: n,
        updatedAt: n,
        points: Array.from({ length: 20 }, (_, i) => ({
          x: (x + i) / 32768,
          y: (y + Math.sin(i / 3) * 12) / 32768,
          pressure: 0.4,
        })),
      });
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  const start = performance.now();
  await page.getByRole('button', { name: 'Open whiteboard: Whiteboard' }).click();
  await expect(board.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
  const initialMs = performance.now() - start;
  const strokes = board.locator('[data-stroke]');
  await expect(strokes).toHaveCount(500);
  const before = await strokes.first().boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const contacts = [
    { id: 1, x: 510, y: 410 },
    { id: 2, x: 650, y: 410 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contacts });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: contacts.map((contact) => ({ ...contact, x: contact.x - 65, y: contact.y - 35 })),
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(async () => (await strokes.first().boundingBox())!.x)
    .toBeLessThan(before!.x - 60);
  await expect(strokes).toHaveCount(500);
  await expect(board.getByRole('button', { name: 'Pen tool', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(board.locator('canvas')).toHaveCount(0);
  console.log(
    'WHITEBOARD PERFORMANCE',
    JSON.stringify({ strokes: 5000, points: 100000, mountedStrokes: 500, initialMs }),
  );
  await info.attach('whiteboard-performance', {
    body: JSON.stringify({ strokes: 5000, points: 100000, mountedStrokes: 500, initialMs }),
    contentType: 'application/json',
  });
  await cdp.detach();
});

test('capture workspace screenshots', async ({ page }) => {
  test.skip(!process.env.LWPDF_SCREENSHOTS);
  await open(page);
  await page.getByLabel('Page fit').selectOption('page');
  await expect(page.locator('.pdf-page')).toHaveAttribute('data-rendered', 'true');
  await attachAt(page, 175, 225);
  await page.getByLabel('Title', { exact: true }).fill('Energy transfer sketch');
  await page.getByRole('button', { name: 'Create whiteboard' }).click();
  const board = page.getByRole('dialog', { name: 'Whiteboard', exact: true });
  await expect(board.locator('.ink-layer')).toHaveAttribute('data-ink-loaded', 'true');
  await board.getByLabel('Whiteboard background').selectOption('dotted');

  async function line(points: number[][]) {
    await page.mouse.move(points[0][0], points[0][1]);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 3 });
    await page.mouse.up();
  }
  for (const [x, y] of [
    [339, 350],
    [590, 250],
    [841, 350],
  ]) {
    await line(
      Array.from({ length: 33 }, (_, i) => [
        x + 69 * Math.cos((i * Math.PI) / 16),
        y + 45 * Math.sin((i * Math.PI) / 16),
      ]),
    );
  }
  await line([
    [413, 329],
    [508, 271],
    [489, 271],
    [508, 271],
    [502, 289],
  ]);
  await line([
    [665, 266],
    [769, 329],
    [748, 327],
    [769, 329],
    [757, 310],
  ]);
  await line([
    [766, 388],
    [685, 438],
    [592, 458],
    [525, 400],
    [540, 300],
    [528, 320],
    [540, 300],
    [546, 323],
  ]);
  const lettering: Record<string, number[][][]> = {
    A: [
      [
        [0, 20],
        [8, 0],
        [16, 20],
      ],
      [
        [3, 13],
        [13, 13],
      ],
    ],
    D: [
      [
        [0, 20],
        [0, 0],
        [9, 0],
        [15, 6],
        [15, 14],
        [9, 20],
        [0, 20],
      ],
    ],
    F: [
      [
        [0, 20],
        [0, 0],
        [15, 0],
      ],
      [
        [0, 9],
        [12, 9],
      ],
    ],
    O: [
      [
        [0, 4],
        [5, 0],
        [13, 0],
        [17, 5],
        [17, 15],
        [12, 20],
        [4, 20],
        [0, 15],
        [0, 4],
      ],
    ],
    P: [
      [
        [0, 20],
        [0, 0],
        [12, 0],
        [16, 4],
        [16, 8],
        [12, 11],
        [0, 11],
      ],
    ],
    T: [
      [
        [0, 0],
        [17, 0],
      ],
      [
        [8, 0],
        [8, 20],
      ],
    ],
  };
  for (const { word, x, y } of [
    { word: 'FOOD', x: 301, y: 338 },
    { word: 'ATP', x: 563, y: 239 },
    { word: 'ADP', x: 814, y: 338 },
  ]) {
    for (const [i, letter] of [...word].entries()) {
      for (const path of lettering[letter])
        await line(path.map(([dx, dy]) => [x + i * 21 + dx, y + dy]));
    }
  }
  await expect(board.getByRole('button', { name: 'Undo ink' })).toBeEnabled();
  await page.screenshot({ path: 'docs/screenshots/whiteboard.png' });
  await board.getByRole('button', { name: 'Back to PDF' }).click();
  await expect(
    page.getByRole('button', { name: 'Open whiteboard: Energy transfer sketch' }),
  ).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/whiteboard-anchors.png' });
});
