# Performance evaluation

These are measurements from headless Chromium 156.0.8078.79 on a shared Linux Codex Cloud machine on 2026-11-15, at 1180×820 with DPR 1. They are not iPad Air/Safari results or a device performance guarantee. Raw records are in [benchmarks](benchmarks/).

## Method

The Playwright benchmark loads the production app, imports a PDF through the actual file input, waits for its canvas **and text layer**, returns to the library, reopens the local copy, and performs 40 distant page jumps. Latency runs from the automation action to a ready page layer and includes automation overhead. Zoom latency includes rebuilding the current canvas and text layer. No forced GC is used. Data comes from the real IndexedDB-backed reader and committed Rust WASM.

The vector/text fixture has 1,500 original pages and is 1,104,935 bytes. The heavier fixture has 1,500 pages and is 170,934,825 bytes (163.0 MiB), containing 64 unique deterministic 2048×2048 JPEG noise images reused across pages. Neither reproduces the full content complexity or image uniqueness of a real textbook. The heavy file is generated locally and excluded from Git.

## Measured results

| 1,500-page fixture     | Initial import → first page | Reopen local file | Median distant jump | Jump range (40 samples) | Zoom   | Live canvases |
| ---------------------- | --------------------------- | ----------------- | ------------------- | ----------------------- | ------ | ------------- |
| Vector/text, 1.05 MiB  | 2.431 s                     | 0.986 s           | 147 ms              | 95–507 ms               | 141 ms | 2–3           |
| Illustrated, 163.0 MiB | 8.750 s                     | 0.893 s           | 350 ms              | 156–646 ms              | 242 ms | 2–3           |

Initial import includes file selection, validation, full content hashing, IndexedDB persistence and first rendering. Reopen does not rehash or copy the entire document into a main-thread ArrayBuffer. These are single recorded runs with 40 navigation samples, not repeated device-level percentiles.

For the illustrated run, main JS heap samples ranged from 5.8 to 12.5 MiB. Aggregate browser RSS rose from 878 MiB to 1491 MiB, peaking at 1491 MiB; one second after closing the reader it was 1163 MiB. Growth was steep during initial unique image visits and flatter later. This is a short stress run and does not prove leak-free long sessions. The substantial native/process footprint remains a first-release limitation.

Restoring 5,000 highlights from a 1,532,637-byte JSON backup took 3.579 s; reopening the annotated file took 1.540 s; a distant jump took 247 ms. Only 200 annotation rows mount initially, with an explicit Show more control. Each visited benchmark page had five saved highlights.

The Rust WASM core validated and canonically serialized 10,000 annotations / 20,000 rectangles in a mean 65.11 ms over 20 iterations. Index construction took 28.30 ms and page lookup plus JSON serialization averaged 17.89 µs over 10,000 calls in Node v24.22.1. These are core-operation timings, not browser interaction timings.

The production build has ~99 kB of initial application JS (37 kB gzip), a separately loaded ~507 kB PDF engine (155 kB gzip), a local 1.33 MB worker, and a 190 kB core WASM binary (61 kB gzip). The offline shell including fonts/CMaps/decoders is about 5.25 MiB. Vite emits its standard large-chunk warning for the separately loaded PDF engine; TypeScript/Svelte checks report zero diagnostics.

Recorded application source revision: `0c6d346`. Raw JSON includes UTC timestamps and every sample. Screenshots are from the same original synthetic study fixture.

## Resource limits and practical limits

The mounted window is visible pages plus a nearby buffer, capped at nine canvases. A queue permits two simultaneous rendering/text jobs, prioritizes the current page, and skips canceled work. Each canvas is limited to 4,000,000 pixels, 4096 pixels per side and DPR 2; high zoom trades bitmap sharpness for memory safety. Unmounted canvases are zeroed, obsolete renders/text work canceled, page resources cleaned, and the entire loading task destroyed on document close. Mixed dimensions and rotations are accounted for in placeholders and per-page fit scales.

The canvas window is bounded; **total PDF memory is not constant**. PDF.js retains parsing data, visited byte ranges, and its own caches. Browser image/GPU resources, font caches, IndexedDB Blobs and allocators add memory outside the main JavaScript heap. The heavy run shows significant native/browser memory growth despite the low canvas count. This requires Safari profiling with actual textbooks before broad release; do not interpret a small JS heap as the whole application’s footprint.

`browserRssBytes` sums `/proc/<pid>/status` VmRSS across Chromium processes returned by CDP. It includes browser/GPU/utility/renderer overhead and can double-count shared mappings. It is an approximate process-level trend, not unique application memory or an iPad memory prediction. Main heap samples use Chromium’s `performance.memory`, excluding PDF worker heaps and native resources. Closing the reader is sampled one second later without forced GC; retained RSS is not by itself proof of a live-object leak or complete memory release.

## Reproduce

```sh
npm ci
npm run build
npm run test:browser
npm run fixtures:heavy
LWPDF_BENCHMARK_FILE=heavy.pdf npm run test:browser -- --grep 'large PDF benchmark' --output=test-results-heavy
npm run benchmark:core
```

Preserve `test-results/performance-*.json` before another full run clears that folder. Run performance scenarios sequentially and compare distributions on the same machine, fixture and viewport; the shared Cloud host adds variance. The core benchmark validates and canonicalizes 10,000 annotations / 20,000 rectangles (20 iterations), builds a page index once, and makes 10,000 batched page lookups. Its lookup measurements include returned JSON serialization and WASM boundary overhead.

## Next performance work

Profile Safari/PWA memory with 300–800 MB real textbooks, study the worker/native image-cache plateau and repeated document switching, then evaluate coordinated idle document cleanup or alternative file storage only against those measurements. Characterize touch scroll, selection handles, keyboard/viewport resizing, Pencil input and native pinch on actual iPad hardware. Extend stress tests to longer sessions and embedded CJK fonts, scanned/JPEG2000 diagrams and thousands of distinct images. OCR and embedded-annotation export should follow the reliability and hardware acceptance work. The later vector-ink extension is measured separately below.

## Vector ink extension

The original measurements above describe the pre-ink revision. Ink uses SVG layers rather than extra page canvases, 12 cached pages, spatially indexed erasing and bounded session history. See [ink-core.json](benchmarks/ink-core.json) for the current 5,000-stroke / 60,000-point Rust WASM benchmark and [PENCIL.md](PENCIL.md) for input/rendering limits and required device testing. The browser stress scenario restored 5,000 strokes / 60,000 points (including 1,000 strokes on one page) into a 1,500-page synthetic PDF. Import took 7.509 seconds; reopening and rendering the dense first page took 1.304 seconds. Strokes survived distant navigation and reload. At most nine interactive page layers were allowed, with no extra annotation canvases. See [ink-browser.json](benchmarks/ink-browser.json).

For 5,000 strokes / 60,000 points all on one page, the Rust WASM benchmark validated/canonically serialized the 4.66 MB vector payload in 103.61 ms and built its spatial eraser index in 37.90 ms. Thirty incremental eraser batches had a median 0.238 ms and maximum 1.470 ms, including returned JSON. This measures geometry work, not end-to-end or physical Pencil latency.

The normal 40-jump reader benchmark with the new ink layers but no handwritten content kept 2–3 PDF canvases live, with median navigation 167 ms and 154 ms zoom; see [ink-reader-navigation.json](benchmarks/ink-reader-navigation.json). Actual writing did not trigger a PDF page rerender in the browser test. No real iPad latency or memory numbers are claimed.

The current build contains approximately 132 kB initial app JS (48 kB gzip) and a 300 kB Rust WASM binary (82 kB gzip); PDF engine/worker assets remain separately loaded/local. The offline application cache is about 5.38 MiB. Run `npm run benchmark:ink` to reproduce the core measurement.
