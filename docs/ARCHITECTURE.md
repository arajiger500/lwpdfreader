# Architecture

The application has no server-side data path. Vite produces a static Svelte 5/TypeScript application; Workbox caches its same-origin runtime resources. User data is entirely separate from application caches.

## Boundaries

| Area                               | Responsibility                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `App.svelte`, `Library.svelte`     | Startup, library import/removal, theme, backup commands, user-visible errors                         |
| `Reader.svelte`                    | Reading session, annotation mutation commands, save status, lifecycle progress flush                 |
| `Viewer.svelte`, `virtual.ts`      | Logical scroll space, page offsets, measured dimensions, bounded live window, navigation generations |
| `PdfPage.svelte`, `renderQueue.ts` | Canvas/text-layer rendering, cancellation, canvas release, normalized geometry projection            |
| `pdf.ts`, `hash.worker.ts`         | Local Blob range transport, PDF.js worker, outline resolution, incremental SHA-256 worker            |
| `storage.ts`                       | Versioned IndexedDB schema, transactions, separate Blob store, per-document annotation index         |
| `backup.ts`                        | Portable JSON schema, complete validation, atomic import/export snapshots                            |
| `progress.ts`                      | Serialized writes, 600 ms coalescing, retry state, prevention of stale failed writes                 |
| `core/src/lib.rs`, `core.ts`       | Rust geometry validation, canonical serialization, page grouping, geometry hit testing via WASM      |

## PDF lifecycle and memory

Import parses a document once for validation and page count. The same loaded document is handed into the reader. Reopen uses the persisted Blob. A custom `PDFDataRangeTransport` provides 256 KiB requested ranges rather than reading and transferring the entire file at startup. PDF.js may retain visited byte ranges; this is not constant total memory regardless of document size. Hashing reads 4 MiB chunks in a separate worker without duplicating the full file.

A numeric offset array describes all pages, initially using the first page’s dimensions. Only pages in the visible window and one nearby page on either side are mounted, capped at nine. Actual dimensions replace estimates when encountered. Anchor correction preserves the current page and relative offset when mixed page sizes are discovered. A navigation generation discards late anchor corrections after a newer explicit jump. Subpixel scroll rounding is accounted for.

At most two canvas/text render jobs run concurrently. Queued canceled jobs never start; active tasks are canceled on scale, rotation or window changes. Current page components mount before buffered pages. DPR is capped at two; each canvas is capped at 4,000,000 pixels and 4096 pixels per side. At very high zoom bitmap sharpness decreases while text geometry remains correct. PDF.js continuations yield to animation frames. Disposed canvases are set to zero size, text tasks are canceled and page resources are cleaned. Closing the reader destroys its loading task/worker after components unmount.

Scroll-driven state updates are throttled; annotation indexing is independent of scroll. Outline resolution starts after first-page initialization and does not block reading.

## Coordinate contract

Stored rectangles use **unrotated PDF crop-box coordinates normalized to [0,1], origin bottom-left**. Geometry includes x, y, width and height. PDF.js viewport transforms convert screen selection rectangles into PDF coordinates, accounting for crop origins, intrinsic rotation, additional view rotation and scale. Overlay projection uses the inverse operation. Range geometry spans all selected text nodes; contained duplicates from browser Range APIs are removed. The overlay has `pointer-events:none`, so text remains selectable.

Selected text provides a human-readable anchor along with page, content fingerprint and rectangles. Replacing the underlying PDF with edited content yields a different document ID; the release does not attempt fuzzy reanchoring across revisions.

`AnnotationIndex` is a Rust BTreeMap indexed by page and used by production rendering and tap hit testing. Construction and page retrieval are batched JSON calls. The Rust validator rejects malformed geometry, versions, colors, identity conflicts and excessive records. Canonical serialization has stable field order and document/page/ID ordering. DOM work, PDF viewport transformations and IDB orchestration stay in TypeScript.

## Persistence and recovery

IndexedDB database version 1 contains document metadata, Blob files, annotations (`by-document` index), and settings. `migrateDatabase` creates schema only for oldVersion < 1; future migrations extend that function and increment the opening version. Annotation format and backup envelope have independent explicit versions. Unsupported future backup versions fail closed.

All persistent mutations await transaction completion. Annotation UI state changes only after commit. Progress writes are serialized and coalesced without indefinite debounce starvation. Failed positions remain pending unless superseded; errors reach the UI. Notes save after 450 ms, blur and backgrounding. Progress additionally flushes on visibility changes, pagehide and document switching; unloading is not the sole persistence mechanism. Browser process termination may lose the final debounce interval or an uncommitted transaction; committed IDB transactions survive normal reloads.

Import fingerprints deduplicate binary-identical documents. A duplicate import retains existing annotations and progress. Removal atomically deletes file, metadata and annotations. Backups take a consistent read transaction snapshot. Restore validates the full envelope and every annotation through Rust before creating a transaction; identity/page-count conflicts abort all changes. Newer timestamps win for matching IDs. Missing PDF metadata is preserved as unavailable and reattached by matching SHA-256 on import. Tombstones are not exported, so merges can resurrect deletions. Multiple simultaneous editing tabs are unsupported; no cross-tab conflict protocol is implemented.

## Offline and updates

The build precaches all required JS, CSS, worker MJS, core WASM, PDF decoding WASM, CMaps, fonts and icons (~5.2 MiB in the measured build). Fonts and maps are copied from the installed PDF.js package at npm postinstall for both dev and production. No CDN is used. Imported documents are never service-worker cache entries. No service-worker handler modifies IndexedDB. A waiting update is applied explicitly from the library, keeping it out of an active reading session. The original imported PDF is never modified.

Note editing uses a shared in-flight save promise that drains new edits arriving during a write. Closing the editor/sidebar, selecting another annotation, returning to the library and exporting a backup await that promise. A failed save keeps the editor and its draft open for retry. Intentional deletion cancels draft autosaving so an outstanding save cannot recreate a deleted annotation. This protects normal navigation; force termination still cannot guarantee the final uncommitted characters.

The page-number field maintains an editing draft separately from scroll-driven progress, and navigation controls wait until initial position restoration has completed. This prevents a late restore report from replacing a page number being typed.
