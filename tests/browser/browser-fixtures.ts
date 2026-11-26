import { test as base } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { expect, type Page } from '@playwright/test';

export const test = base.extend({
  context: async ({ context, browserName, playwright, baseURL, viewport }, use) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }
    // Linux WebKit's ephemeral contexts reject IndexedDB Blob writes. A
    // disposable persistent profile tests the same Blob storage as Safari.
    const profile = await mkdtemp(join(tmpdir(), 'lwpdf-webkit-'));
    try {
      const persistent = await playwright.webkit.launchPersistentContext(profile, {
        baseURL,
        viewport,
      });
      try {
        await use(persistent);
      } finally {
        await persistent.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
});
