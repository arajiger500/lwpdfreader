# Pencil, pen, marker and eraser tools

This implementation adds persistent vector ink to the existing PDF reader. It has been exercised in Chromium on Linux with mouse input, CDP pen/pressure events and emulated touch. These are **not** real Apple Pencil or iPad Safari measurements. Physical-device acceptance remains required.

## Use

The docked toolbar has Hand, Text highlight, Pen, Freehand highlighter, Eraser, Tool options, Undo, Redo and Collapse. Its tool buttons have 44 px targets on iPad layouts. Hand allows native finger scroll/pinch and mouse drag panning. Text restores native PDF text selection and the existing selection-color toolbar. Pen/marker/eraser tools disable text selection on the page. Collapse selects Hand so reading does not accidentally draw. Focus reading hides the dock and also selects Hand.

Pen uses black, blue, red, green or a custom hex color. Marker has yellow, green, pink, blue, orange and custom colors, with opacity 0.28. Each tool remembers its own color and width. Options include input smoothing, optional finger drawing, eraser size/mode and Pen only / Marker only / Both targets. Settings are saved in IndexedDB. Text highlights, region highlights, notes and bookmarks remain independent; the ink eraser cannot remove them.

Precision erasing splits a vector centerline where the eraser's round swept path intersects the brush footprint. Cut endpoints interpolate pressure. The cut is conservatively expanded by half the stroke width so round caps do not protrude back into the erased area. It is a vector segment eraser, not a per-pixel mask capable of shaving one side off a very broad marker. Whole-stroke mode removes every surviving fragment of the touched original stroke.

Undo/redo changes actual IndexedDB state. Keyboard shortcuts are Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z outside editable text fields. History is scoped to the open document session and limited to 80 actions / 200,000 retained points. Saved results persist; undo history itself resets on reopening. Very long continuous pen/marker input is split into bounded vector chunks sharing one original stroke identity, rendering opacity and undo action.

## Input behavior and browser limits

- Pointer Events handle pen, mouse and optional touch drawing, with pointer capture, cancellation, lost capture and page/background interruption handling. Supported coalesced events are consumed in batches. The final sample is retained. Pen cancellation commits observed partial ink; a canceled finger drawing is discarded to avoid navigation marks.
- Varied/non-default pressure from a `pen` pointer drives width. Mouse/touch and default constant pen pressure use constant width. Pressure is saved per point where available. No pressure is invented for devices that do not report it. Optional smoothing operates on captured coordinates, so erasing and persisted rendering use the same centerline.
- With finger drawing off, touches pan the viewer in drawing modes. A captured pen suppresses finger panning/marks, with a short 450 ms guard after lift. This is a practical input filter, **not guaranteed palm rejection**. Safari/OS classification, palm-before-pen contacts and browser-reserved edge gestures still require testing. Finger drawing deliberately relaxes the normal touch filter.
- CSS `touch-action` cannot be changed reliably per pointer after a gesture begins. Drawing modes use `touch-action:none` and explicit finger panning/inertia; Hand and Text modes retain browser-native pan/pinch. Switch to Hand for native pinch zoom. Toolbar zoom remains available and updates PDF and ink coordinate transforms.
- Safari support for `getCoalescedEvents` varies; feature detection falls back to ordinary pointer events. Apple Pencil double-tap, squeeze, hover predictions, native palm-rejection APIs and native latency parity are not promised or simulated. There is no fake double-tap switch control.
- Points at the page boundary are clamped and all SVG layers clip to that page. Pointer capture allows writing near an edge, but cannot suppress all iPadOS system gestures.

References verified during implementation: [Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events), [touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action), [coalesced events](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents).

## Rendering and geometry

Each virtual page owns separate marker and pen/interaction SVG layers; no annotation canvas is allocated. The existing PDF canvas and PDF.js text layer are independent. Existing PDF text highlights stay on their own HTML layer. Marker SVG uses multiply compositing over the PDF, with group opacity applied once per original stroke, including precision-cut fragments. Self-overlapping segments therefore do not repeatedly blend within one marker stroke. Opaque pen sits above marker.

Stroke points use normalized, unrotated crop-box coordinates with bottom-left origin. Width is normalized to the shorter crop-box side. The PDF.js viewport matrix positions SVG paths, accounting for crop origin, intrinsic rotation, view rotation, zoom and PDF UserUnit. Geometry paths stay in PDF space; zoom changes the transform rather than rasterizing handwriting. Constant-width strokes use round SVG caps/joins; pressure strokes use a filled variable-width outline with round end caps.

Pointer samples and the live draft are outside framework reactive state. A requestAnimationFrame updates the temporary SVG path; pen input performs no per-point WASM calls or PDF rerender. Completed changes update only the affected page subscription. A page cache evicts inactive pages beyond 12; only the existing virtual window (at most nine pages) mounts interactive layers. History and pending changes are separate from that cache.

Rust validates/canonically serializes stroke batches. A per-gesture Rust `InkEraser` holds a page snapshot and a 32×32 spatial index. New eraser pointer batches query candidate bounds and use analytic circle/strip capsule intersections, including crossings between widely separated samples. Browser DOM, input, viewport conversion and SVG rendering stay in TypeScript. Rust never parses the PDF.

## Persistence, migration and backups

IndexedDB upgrades from version 1 to version 2 by adding `ink` (indexed by document and document/page) and `inkDeleted`. Existing PDF files, text annotations, metadata, settings and progress stores are untouched. Stroke records have their own version 1 schema. Each completed stroke or eraser action starts an immediate transactional write; dependent actions serialize. Undo and redo apply inverse transactions and check for conflicting stored vectors.

Live changes appear optimistically with an explicit pending state. Failed writes retain the unsaved vectors in memory, expose **Retry ink**, disable further new gestures and block leaving/exporting until recovery. An already active gesture is finalized into that pending queue. Page changes do not discard pending vectors. Browser force termination or a forced reload during an uncommitted/failed write cannot be guaranteed safe; wait for saving to finish and never ignore an error. Original PDFs and external backups remain necessary against iPadOS storage eviction.

Backup version 2 includes all legacy text annotations/progress, vector strokes and timestamped ink deletion records. Version 1 backups still import. Older ink backups cannot resurrect a newer erased stroke; newer undo restoration can supersede its deletion. Text-annotation backups retain the original additive merge behavior. Backups include metadata and vectors, not original PDF files. Old application versions cannot import the new v2 backup envelope. Close older reader tabs before updating to the new database schema.

Safety limits include 8,192 points per stored vector chunk, 100,000 stroke records / 2,000,000 points per validation/export batch, and the existing 50 MiB backup file import limit. Multiple simultaneous editing tabs remain unsupported; conflicts fail visibly rather than silently replacing an edited stroke.

## Physical iPad acceptance

1. Deploy this branch over HTTPS; update the installed PWA from the library and close older tabs. Confirm existing notes/highlights/progress remain after migration.
2. On iPad Air 5, draw fine handwriting and fast loops with Pencil in portrait and landscape, at several widths/colors and pressures. Write to all page/screen edges. Check Safari and standalone mode separately.
3. Keep a palm resting before, during and after Pencil contact. Verify fingers scroll without marks when finger drawing is off. Test quick pen-to-finger transitions and the optional finger-drawing toggle; record any classification or scrolling surprises.
4. Mark text, illustrations and blank space. Retrace one marker stroke and confirm no internal dark patch. Add a second stroke over it; intentional overlaps between distinct strokes can darken. Test pen above marker.
5. Test both eraser modes, all target filters, small and large sizes, sparse fast swipes, overlapping strokes, dots and pressure-varying lines. Precision cuts should split correctly; undo/redo should restore the original appearance.
6. Zoom via toolbar, switch to Hand and pinch, rotate the view/device, visit mixed/cropped/intrinsically rotated pages, and jump between distant chapters. Ensure the same ink remains aligned.
7. Interrupt a stroke by backgrounding, locking, leaving the screen edge and changing pages. After saving finishes, close/reload/reopen and verify every committed remaining vector. Exercise an intentional failed write in a disposable profile and verify retry without losing the in-memory draft.
8. Export one-document and full-library v2 backups to Files, restore into a clean profile, reimport original PDFs, and check ink, erasures, text annotations and progress. Restore an older ink backup after erasing and verify it does not resurrect deleted strokes.
9. Repeat offline after the new shell has cached. Test 300–800 MiB real textbooks and dense handwriting over a long study session, profiling memory if tooling is available. Do not infer iPad latency or memory safety from Linux timings.

## Verification summary

26 Rust unit tests, 50 TypeScript tests and 18 Chromium browser scenarios passed, plus the complete ink workflow on the 163 MiB illustrated fixture. The 5,000-stroke / 60,000-point stress document reopened its 1,000-stroke first page in 1.304 seconds in the recorded Linux run; importing that backup took 7.509 seconds. Rust spatial-index construction took 37.90 ms for 5,000 strokes, with median incremental erase batch geometry/serialization time 0.238 ms. These measurements do not establish physical Apple Pencil latency, perfect palm rejection, or iPad memory safety. Raw records are under `docs/benchmarks/ink-*.json`.

![Pen and translucent marker](screenshots/ink-tools.png)
