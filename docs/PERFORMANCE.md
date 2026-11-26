# Performance evaluation

## Study workspace comparison · 2026-11-26

The repeated comparison uses the PR #2 head `3dbfa45` and the study workspace application at `2a681a0`. The additional final checks and sustained run use `19b2987`, which adds file-picker sequencing and touch cancellation fixes. Both builds ran on the same shared Linux Codex Cloud environment with Chromium 156.0.8078.79, Node 24.22.3, a 1180 × 820 viewport and DPR 1. Each test started a clean browser context. Startup timing starts after browser launch. See [raw records](benchmarks/study-workspace/).

### Document rendering

Each fixture has 1,500 pages. Each build ran three separate imports and 40 distant jumps per run, using byte-identical fixtures. Import, local reopen and toolbar zoom are medians across the three trials. Jump median and p95 pool 120 per-fixture observations. Timings include Playwright overhead and page readiness includes the selectable text layer. They describe workload differences within this environment.

| Fixture                |    Import, ms | Reopen, ms | Jump median, ms | Jump p95, ms | Toolbar zoom, ms | Peak aggregate RSS, MiB |
| ---------------------- | ------------: | ---------: | --------------: | -----------: | ---------------: | ----------------------: |
| Vector/text · 1.05 MiB | 1,366 → 1,385 |  554 → 915 |   118.0 → 108.5 |    215 → 189 |        124 → 153 |               765 → 757 |
| Illustrated · 163 MiB  | 4,449 → 3,854 |  396 → 351 |   205.5 → 174.5 |    411 → 315 |        299 → 161 |           1,477 → 1,458 |
| Illustrated · 327 MiB  | 6,431 → 6,429 |  932 → 867 |   280.0 → 273.0 |    415 → 384 |        216 → 271 |           1,704 → 1,657 |

The single-reopen timings for the vector PDF varied from 503–949 ms before and 403–976 ms after. The separate 18-cycle test showed similar medians. The library now waits for the previous PDF worker to close before accepting another document. Toolbar zoom reports when the new raster and text are ready. The vector and 327 MiB fixtures took longer at that endpoint, while same-rotation updates kept the old raster visible.

The 163 MiB fixture embeds 64 unique JPEGs. The larger, approximately 327 MiB fixture reuses 128 deterministic JPEGs across two figure panels per page and adds a longer text block. Both are synthetic. They exercise figure decoding and text layout while sharing more image data than most real textbooks.

### Activity, memory and ink

The efficiency test samples six close/reopen cycles per trial, 1.5 seconds of settled idle time, 60 injected pen moves, and 30 injected two-finger moves. It records CDP TaskDuration, per-process RSS and CPU time, main and worker JavaScript heaps, backing stores, mounted canvas pixels, long tasks, frame intervals, SVG draft mutation times, and completed IndexedDB read/write transactions. The transaction instrument counts store participation, so one ink transaction appears under both ink and inkDeleted. Neither the mutation latency nor the rAF intervals measure touchscreen-to-display or Apple Pencil latency.

| Vector fixture proxy                                            | Before → After |
| --------------------------------------------------------------- | -------------: |
| Cold navigation to the library, median ms                       |      289 → 252 |
| Reopen across 18 repeated cycles, median ms                     |      367 → 365 |
| Main renderer task time during the 1.5 s idle sample, median ms |      7.4 → 3.6 |
| Pen event to live SVG mutation, p95 ms                          |      0.8 → 1.4 |
| Main JS heap after reopen, median MiB                           |      9.3 → 9.8 |
| PDF worker JS heap after reopen, median MiB                     |      6.8 → 8.7 |
| Initial JS, kB                                                  |   132.4 → 83.6 |
| Initial JS, gzip kB                                             |    47.8 → 30.8 |
| Offline cache payload, MiB                                      |  5.384 → 5.412 |

Idle samples recorded zero page-rendered events and zero completed write transactions in both builds. One ink gesture used one completed ink transaction in both builds. Each open-cycle snapshot showed one PDF worker. Immediate-close snapshots sometimes preceded termination. The heavy one-page worker heap sample was 6.9 → 6.6 MiB. Long-task counts across the three full detailed vector journeys were 6 before and 4 after, including boot and import.

In Pen mode, the same injected pinch left the baseline page width unchanged. The new viewer scaled it from 1,133 to 1,733 CSS pixels with zero completed page renders during motion and one after release. Median release-to-ready was 93 ms (range 90–109 ms). Gesture rAF intervals reached 16.7 ms at p95 in this headless run. Mounted canvas allocation rose from 1,705,978 to 3,928,144 pixels as the page occupied more layout space.

The short-stroke SVG mutation p95 increased by about 0.6 ms. The timed trace has 60 moves and does not exercise the long-stroke path bound. Worker heap samples moved upward on the vector fixture while the illustrated worker spot check moved downward. Both sample the browser’s current GC phase without forced collection.

The cold-start trials are too few to establish a reliable startup latency improvement. The reduction in initial JS comes from loading the reader separately. All application JS and the editor still occupy space in the offline cache, which grows with the new features.

The detailed logs keep browser, renderer, and GPU-process RSS separate. Summing their RSS can double-count shared mappings. GPU-process RSS provides a process trend and excludes a reliable tally of graphics memory. The PDF worker isolate and ArrayBuffer backing stores are separate from main-thread JS. PDF.js can retain visited range data and native image buffers even after the reader releases its own canvases. The application keeps at most nine mounted page canvases and up to two in-flight staging canvases. Each has a 4-million-pixel cap.

| Dense workload       | Backup restore, median ms | Annotated-document reopen, median ms |
| -------------------- | ------------------------: | -----------------------------------: |
| 5,000 highlights     |             1,057 → 1,013 |                            458 → 949 |
| 5,000 strokes on PDF |             2,385 → 2,467 |                            416 → 418 |

The highlights-only reopen median was slower. The test includes reading and projecting saved annotations as well as raster and text readiness, and the three after runs ranged from 503 to 1,011 ms. The dense-ink reopen and the longer repeated vector cycle timings stayed close to the baseline. The 5,000-stroke board loaded in 363 ms from the marker click to the ink layer reporting readiness. It mounted 500 nearby strokes and no board canvas. The test panned with Pen selected and preserved the stroke count. This scenario has no baseline feature to compare.

A two-minute single-page session on the 327 MiB synthetic textbook visited 218 distant page targets and saved 654 strokes. The last page retained its three strokes after a local reopen. Periodic samples recorded at most 1 mounted canvas (355,796 pixels) and aggregate browser RSS from 1,243 to 1,607 MiB. This duration captures repeated decode and annotation activity. Longer real-device sessions remain necessary for allocator, thermal and storage behavior.

The final-build spot checks recorded 165 ms median distant navigation and 156 ms toolbar zoom on the 163 MiB fixture. The final-build vector pinch recorded no completed renders during motion and one after release. [Spot-check records](benchmarks/study-workspace/)

### Stabilization and design choices

The [synthetic 120 Hz trace](benchmarks/study-workspace/stabilization.json) compares the previous 0.65 gain, the four new levels, and one configured One Euro filter. Medium reduced mean-centered slow-motion jitter from 0.446 to 0.343 CSS pixels, fast-corner maximum error from 1.62 to 1.20 pixels, and the largest pressure step from 0.70 to 0.37. The One Euro variant further reduced mean-centered jitter to 0.223 pixels with greater overall slow-motion error on this trace. High trades more positional lag for stronger filtering. These figures describe one deterministic signal, including its specified filter tuning.

The reader keeps the vector SVG and existing analytic eraser. Long live strokes seal older geometry in 192-sample paths, reducing the amount of geometry regenerated per frame. Whiteboards mount only the nearby SVG geometry. A Canvas rewrite or tiled PDF renderer would add another cache and compositing path. The observed viewport footprint and existing bounds favored a retained-raster swap, reusable text layers and prompt cancellation of obsolete work. The Rust/WASM interface and production dependencies remain unchanged.

The library loads the reader, PDF engine and editor as needed. Workbox still precaches their assets for offline startup. Native drawing-mode scroll branches, the recursive scroll timeout, eager outline loading, and redundant eraser preview regeneration were removed. Pausing page jobs while hidden and stopping application work between input events are expected to reduce avoidable CPU/GPU work. The Linux measurements do not establish device battery drain, Pencil latency, sustained hardware FPS or Safari graphics memory. [Physical iPad checklist](STUDY-WORKSPACE.md)

### Reproduce

```sh
npm ci
npm run build
npm run fixtures:heavy
LWPDF_FIXTURE_IMAGES=128 npm run fixtures:heavy

npm run test:browser -- --grep 'large PDF benchmark'
LWPDF_BENCHMARK_FILE=heavy.pdf npm run test:browser -- --grep 'large PDF benchmark'
LWPDF_BENCHMARK_FILE=illustrated.pdf npm run test:browser -- --grep 'large PDF benchmark'
LWPDF_EFFICIENCY=1 npm run test:browser -- efficiency.spec.ts --grep 'efficiency proxies'
LWPDF_BENCHMARK_FILE=illustrated.pdf LWPDF_SUSTAINED_MS=120000 \
  npm run test:browser -- efficiency.spec.ts --grep sustained
node --experimental-transform-types scripts/benchmark-stabilization.mjs
```

Repeat each timing scenario independently. Copy generated JSON from `test-results` before another run clears it. For the baseline, build the checkout at `3dbfa45`, use the same fixture files and copy the opt-in `efficiency.spec.ts` harness into that checkout. Use CI=1 to avoid reusing an open preview server. Keep tests sequential and record the browser version, display scale, and machine. The whiteboard scenario has no baseline counterpart.

## Historical first-release measurements

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
