import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'LWPDFReader',
        short_name: 'LWPDF',
        description: 'A quiet place to read and think. Offline PDF reading and annotations.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f4f0',
        theme_color: '#f5f4f0',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,wasm,png,svg,bcmap,pfb,ttf,otf}', '**/licenses/*'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
      },
    }),
  ],
  build: { target: 'safari16.4' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
