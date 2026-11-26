# Linked whiteboards and iPad acceptance

## Study workflow

1. With a PDF open, select **Whiteboard** and tap a point on the page. Enter a title to create a board or choose an existing board to share.
2. Tap a marker to reopen its board. Pen, highlighter, eraser, undo and redo work as they do on a PDF. Choose a background and edit the title in the board header.
3. Pan and zoom with two fingers. **Back to PDF** saves any changes and restores the mounted reading view. The whiteboard resumes at its last saved center and zoom when reopened.
4. Use **Actions** to clear ink, unlink the current point, or permanently delete the board and all links. Clearing is undoable within the session limits. Unlinking preserves the board and other points that open it. A board without a link remains available in the existing-board picker.

The original PDFs remain immutable. Markers store each PDF’s content hash, one-based page, and bottom-left normalized crop-box coordinates. A byte-identical reimport can reconnect restored metadata at the same location. Removing a PDF explicitly removes its links while retaining the separate whiteboards.

## IndexedDB v3 and JSON backups

| Format    | Contents                                                                  |
| --------- | ------------------------------------------------------------------------- |
| Backup v1 | Document metadata, progress, highlights, notes and bookmarks              |
| Backup v2 | The v1 data plus vector ink and ink deletion records                      |
| Backup v3 | The v2 data plus whiteboards, their links, and permanent deletion records |

IndexedDB migrations are additive for v1 and v2 libraries. The v3 upgrade creates `whiteboards` and `boardAnchors`. Old file blobs, annotations, progress, preferences, ink and erasure records stay in their existing stores. Board vector ink uses the existing page index under a separate `whiteboard:<uuid>` identity. Creating a board and its first link is one atomic transaction, as is permanent deletion and removal of the owned ink. The board viewport is saved on close, backgrounding, or a metadata edit.

Restore validates the complete envelope and merges in one transaction. Whiteboard and link tombstones permanently mask their identities across merges, even if a different device has a newer timestamp. Permanent board deletion discards its title, view and ink and masks every link to it. A scoped document backup carries the boards referenced by its live links and shared board tombstones, plus that PDF’s own link tombstones. Export the entire library to include unlinked boards. Backups carry metadata and vectors. Keep the original PDF files separately.

When a whiteboard sketch fails to save, live vectors stay in the session. Retry from the ink toolbar before closing the board. Failed metadata writes leave the draft title/background in the editor and offer a retry. A browser process kill can interrupt a pending transaction. The portable format retains the inherited limits of 100,000 strokes, two million points per validated snapshot, and 50 MiB per imported JSON file.

## Physical iPad Air 5 checklist

- Record iPadOS and Safari versions. Run in Safari and the installed PWA. Upgrade a disposable v1/v2 library and check links, notes, original PDFs, bookmarks, ink, and progress.
- Pinch and pan in Pen, Marker, and Eraser with finger drawing off and on. Start with fingers staggered, add or lift a third finger, and alternate immediately with Pencil. Try edge gestures, palm-before-Pencil, and palm-after-lift. Check one-finger scrolling and native text selection handles.
- Write tiny letters and math at several scales and all stabilization levels. Check fast curves, corners, pressure ramps, erasure, undo, and accuracy on cropped or intrinsically rotated pages. Compare actual tip latency and frame pacing with a high-speed camera or device profiling.
- Attach multiple points to a shared board, pan well beyond the opening view, exit, and reopen. Rotate the device with a board open. Verify the PDF returns to the same point, zoom, and horizontal and vertical scroll.
- Restore a v3 backup into a clean profile, reimport the original PDF, and confirm marker position. Restore older backups after unlinking and deleting. Repeat offline after the new application shell has cached.
- Read a real 1,000–2,000-page illustrated textbook for 30 minutes. Sample Safari CPU/process memory while idle, during rapid jumps, after cycling documents, and across background/lock events. Recheck in standalone mode.

The board is a finite 32,768-unit square with a viewport-sized SVG. At extreme scale or physical scroll boundaries, navigation clamps to valid content. Linux WebKit does not exercise iPadOS Pencil hardware, native selection handles, system gesture arbitration, GPU memory pressure, thermal behavior, or battery drain.
