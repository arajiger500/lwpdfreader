# Study workspace benchmark records

The baseline is PR #2 head `3dbfa45`. The repeated comparison build is `2a681a0`. The sustained run and final checks use `19b2987`, which includes two follow-up input fixes. Browser tests used headless Chromium 156.0.8078.79 at 1180 × 820 and DPR 1 on the same Linux Codex Cloud machine. The test fixture names are `large` for vector/text, `heavy` for the 163 MiB image fixture, and `illustrated` for the 327 MiB two-panel fixture.

| Files                                         | Contents                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `before-nav-*`, `after-nav-*`                 | One import/reopen/zoom trial and 40 distant-jump samples per file                                             |
| `before-efficiency-*`, `after-efficiency-*`   | Startup, six open/close cycles, heap and process snapshots, activity, ink, pinch, production chunks and cache |
| `before-annotations-*`, `after-annotations-*` | Restore/reopen workload with 5,000 highlights                                                                 |
| `before-ink-*`, `after-ink-*`                 | Restore/reopen workload with 5,000 strokes                                                                    |
| `whiteboard.json`                             | Mounting visible paths from a 5,000-stroke board                                                              |
| `stabilization.json`                          | Derived position and pressure error on deterministic synthetic inputs                                         |
| `final-check-*`                               | Final-build efficiency and 163 MiB navigation spot checks                                                     |
| `after-sustained.json`                        | Periodic memory and canvas samples during the two-minute illustrated reading and writing workload             |

The detailed harness checks the loaded entry script against the local build. Early probe runs against an orphaned preview server were discarded before archiving this comparison. Worker counts immediately after close can sample the interval before asynchronous termination. The navigation snapshots record aggregate RSS, which can double-count shared pages. The detailed and sustained records also provide individual process samples.

[Methods, results, and reproduction commands](../../PERFORMANCE.md)
