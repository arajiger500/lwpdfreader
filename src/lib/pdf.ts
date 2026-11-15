import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
let engine: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;
export function pdfEngine() {
  return (engine ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
    module.GlobalWorkerOptions.workerSrc = workerUrl;
    return module;
  }));
}
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
export function fingerprint(file: Blob, progress: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) progress(e.data.progress);
      if (e.data.id) {
        worker.terminate();
        resolve(e.data.id);
      }
      if (e.data.error) {
        worker.terminate();
        reject(new Error(e.data.error));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Could not calculate the PDF fingerprint.'));
    };
    worker.postMessage(file);
  });
}
export async function loadPdf(file: Blob): Promise<PDFDocumentProxy> {
  const { getDocument, PDFDataRangeTransport } = await pdfEngine();
  if (file.size < 5) throw new Error('This file is empty or is not a valid PDF.');
  let cancelled = false;
  const initial = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  class BlobTransport extends PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      void file
        .slice(begin, end)
        .arrayBuffer()
        .then((data) => {
          if (!cancelled) this.onDataRange(begin, new Uint8Array(data));
        })
        .catch(() => {
          void task.destroy();
        });
    }
    abort() {
      cancelled = true;
    }
  }
  const range = new BlobTransport(file.size, initial, true);
  const task = getDocument({
    range,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: '/pdf/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdf/standard_fonts/',
    wasmUrl: '/pdf/wasm/',
    canvasMaxAreaInBytes: 16 * 1024 * 1024,
  });
  let password = false;
  task.onPassword = () => {
    password = true;
    void task.destroy();
  };
  try {
    return await task.promise;
  } catch (e) {
    await task.destroy();
    if (password)
      throw new Error(
        'Password-protected PDFs are not supported in this release. Open an unlocked copy.',
      );
    throw new Error(
      'Could not open this PDF. It may be damaged, unsupported, or unreadable. ' +
        (e instanceof Error ? e.message : ''),
    );
  }
}
export interface OutlineEntry {
  title: string;
  page: number;
  depth: number;
}
export async function getOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const raw = await pdf.getOutline();
  const result: OutlineEntry[] = [];
  type Item = NonNullable<typeof raw>[number];
  async function walk(items: Item[], depth: number) {
    for (const item of items) {
      try {
        const dest =
          typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (dest) {
          const ref = dest[0];
          const page = typeof ref === 'number' ? ref + 1 : (await pdf.getPageIndex(ref)) + 1;
          result.push({ title: item.title, page, depth });
        }
      } catch {
        /* Unsupported external destination: omit it. */
      }
      if (item.items?.length) await walk(item.items, depth + 1);
    }
  }
  if (raw) await walk(raw, 0);
  return result;
}
