# Third-party notices

Application source is MIT. Packages retain their own licenses; inspect exact versions in package-lock.json and core/Cargo.lock.

| Runtime dependency          | License           | Use                                                                           |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Mozilla PDF.js / pdfjs-dist | Apache-2.0        | PDF parsing/rendering, worker, extracted text-layer CSS, fonts/CMaps/decoders |
| Svelte                      | MIT               | UI                                                                            |
| idb                         | ISC               | Typed IndexedDB wrapper                                                       |
| @noble/hashes               | MIT               | Incremental SHA-256                                                           |
| wasm-bindgen                | MIT OR Apache-2.0 | WASM bindings                                                                 |
| serde / serde_json          | MIT OR Apache-2.0 | Rust annotation JSON                                                          |
| Workbox                     | MIT               | Offline service worker                                                        |

The text-layer stylesheet in src/pdf-text-layer.css is extracted from pdfjs-dist/web/pdf_viewer.css, copyright Mozilla Foundation, licensed under Apache License 2.0. PDF.js resources distributed in public/pdf at install/build include their upstream licenses (including font licenses); the build preserves those files. PDF.js includes third-party codecs and font resources with their own notices in the package's LICENSE and resource license files. See the installed package for full license text.

Development tools include Vite, TypeScript, Vitest, Playwright, fake-indexeddb, pdf-lib, sharp, vite-plugin-pwa, wasm-pack and their dependencies under their respective licenses. Test PDFs are original generated fixtures and include no copyrighted textbook content.
