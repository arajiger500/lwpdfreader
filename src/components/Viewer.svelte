<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import PdfPage from './PdfPage.svelte';
  import type { PDFDocumentProxy } from '../lib/pdf';
  import type { PageViewport } from 'pdfjs-dist';
  import type { Annotation, Progress, Rect } from '../lib/types';
  import { AnnotationIndex } from '../lib/core';
  import { RenderQueue } from '../lib/renderQueue';
  import { offsets, pageAt, visiblePages, type Size } from '../lib/virtual';
  import { selectionRects } from '../lib/geometry';
  let {
    pdf,
    initial,
    annotations,
    regionMode,
    focus,
    onProgress,
    onInitialized,
    onSelection,
    onSelect,
    onRegion,
    onError,
    onMessage,
  }: {
    pdf: PDFDocumentProxy;
    initial: Progress;
    annotations: Annotation[];
    regionMode: boolean;
    focus: boolean;
    onProgress: (p: Progress) => void;
    onInitialized: () => void;
    onSelection: (s: { page: number; rects: Rect[]; text: string } | null) => void;
    onSelect: (a: Annotation) => void;
    onRegion: (page: number, r: Rect) => void;
    onError: (e: unknown) => void;
    onMessage: (s: string) => void;
  } = $props();
  let scroller: HTMLDivElement;
  let width = $state(800),
    height = $state(800),
    scrollTop = $state(0);
  let settings = $state<Progress>(untrack(() => ({ ...initial })));
  let fallback = $state<Size>({ width: 612, height: 792 });
  let measured = $state.raw(new Map<number, Size>());
  let initialized = $state(false);
  let index = $state<AnnotationIndex>();
  let current = $state(untrack(() => initial.page));
  let lastScroll = 0;
  let scrollFrame = 0;
  let selectionTimer: ReturnType<typeof setTimeout>;
  let adjusting = false;
  let mounted = true;
  let navigation = 0;
  const queue = new RenderQueue();
  const registry = new Map<number, { el: HTMLElement; viewport: PageViewport; box: number[] }>();
  function pageScale(size: Size) {
    const w = settings.rotation % 180 ? size.height : size.width;
    const h = settings.rotation % 180 ? size.width : size.height;
    if (settings.fit === 'width') return Math.max(0.1, (width - 32) / w);
    if (settings.fit === 'page')
      return Math.max(0.1, Math.min((width - 32) / w, (height - 32) / h));
    return settings.zoom;
  }
  const scale = $derived(pageScale(measured.get(current) ?? fallback));
  const tops = $derived(offsets(pdf.numPages, measured, fallback, pageScale, settings.rotation));
  const pages = $derived(
    settings.mode === 'single'
      ? [current]
      : visiblePages(tops, scrollTop, height).sort(
          (a, b) => Math.abs(a - current) - Math.abs(b - current),
        ),
  );
  const surfaceWidth = $derived(
    Math.max(
      width,
      ...pages.map((n) => {
        const s = measured.get(n) ?? fallback;
        return (settings.rotation % 180 ? s.height : s.width) * pageScale(s) + 32;
      }),
    ),
  );
  $effect(() => {
    const next = new AnnotationIndex(JSON.stringify(annotations));
    index = next;
    return () => next.free();
  });
  export async function goTo(n: number, offset = 0) {
    const request = ++navigation;
    const target = Math.max(1, Math.min(pdf.numPages, Math.round(n)));
    current = target;
    settings.offset = offset;
    adjusting = true;
    onSelection(null);
    await tick();
    if (!mounted || request !== navigation) return;
    scroller.scrollTop =
      (settings.mode === 'single' ? 0 : Math.ceil(tops[target - 1])) +
      offset * (tops[target] - tops[target - 1] - 20);
    scrollTop = scroller.scrollTop;
    adjusting = false;
    report();
  }
  export async function configure(change: Partial<Progress>) {
    const saved = capture();
    settings = { ...settings, ...change };
    await tick();
    await goTo(saved.page, saved.offset);
  }
  export function capture(): Progress {
    const n = settings.mode === 'single' ? current : pageAt(tops, scroller?.scrollTop ?? scrollTop);
    const local =
      (scroller?.scrollTop ?? scrollTop) - (settings.mode === 'single' ? 0 : tops[n - 1]);
    return {
      ...settings,
      page: n,
      offset: Math.max(0, Math.min(1, local / (tops[n] - tops[n - 1] - 20))),
      zoom: settings.fit === 'custom' ? settings.zoom : Math.max(0.25, Math.min(4, scale)),
    };
  }
  function report() {
    if (initialized) {
      const p = capture();
      current = p.page;
      onProgress(p);
    }
  }
  function scroll() {
    if (adjusting) return;
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const now = performance.now();
      if (now - lastScroll < 60) {
        setTimeout(scroll, 60);
        return;
      }
      lastScroll = now;
      scrollTop = scroller.scrollTop;
      report();
    });
  }
  async function size(n: number, w: number, h: number) {
    const old = measured.get(n) ?? fallback;
    if (old.width === w && old.height === h) return;
    const p = capture(),
      request = navigation;
    adjusting = true;
    measured = new Map(measured).set(n, { width: w, height: h });
    await tick();
    if (!mounted || request !== navigation) {
      adjusting = false;
      return;
    }
    scroller.scrollTop =
      (settings.mode === 'single' ? 0 : Math.ceil(tops[p.page - 1])) +
      p.offset * (tops[p.page] - tops[p.page - 1] - 20);
    scrollTop = scroller.scrollTop;
    adjusting = false;
  }
  function hit(n: number, x: number, y: number) {
    const hits: Annotation[] = JSON.parse(index?.hit_test(n, x, y) ?? '[]');
    const a = hits[hits.length - 1];
    if (a) onSelect(a);
  }
  function ready(n: number, el: HTMLElement | null, viewport?: PageViewport, box?: number[]) {
    if (el && viewport && box) registry.set(n, { el, viewport, box });
    else registry.delete(n);
  }
  function selection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        onSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const start = (
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement
      ) as Element | null;
      const end = (
        range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement
      ) as Element | null;
      const startPage = start?.closest<HTMLElement>('.pdf-page');
      const endPage = end?.closest<HTMLElement>('.pdf-page');
      if (!startPage || !endPage) return;
      if (startPage !== endPage) {
        onSelection(null);
        onMessage('Select text on one page at a time. Create a separate highlight for each page.');
        return;
      }
      const n = Number(startPage.dataset.page);
      const entry = registry.get(n);
      if (!entry) return;
      if (!start?.closest('.textLayer') || !end?.closest('.textLayer')) return;
      const rects = selectionRects(
        range,
        entry.el.getBoundingClientRect(),
        entry.viewport,
        entry.box,
      );
      if (rects.length) onSelection({ page: n, rects, text: sel.toString().slice(0, 100_000) });
    }, 180);
  }
  function keys(e: KeyboardEvent) {
    if (!initialized) return;
    const tag = (e.target as HTMLElement).tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      void goTo(current + 1);
    }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      void goTo(current - 1);
    }
  }
  onMount(() => {
    let disposed = false;
    const ro = new ResizeObserver((entries) => {
      const p = capture();
      width = entries[0].contentRect.width;
      height = entries[0].contentRect.height;
      if (initialized)
        void tick().then(() => {
          if (!disposed) void goTo(p.page, p.offset);
        });
    });
    ro.observe(scroller);
    document.addEventListener('selectionchange', selection);
    window.addEventListener('keydown', keys);
    void pdf
      .getPage(1)
      .then(async (page) => {
        if (disposed) return;
        const v = page.getViewport({ scale: 1 });
        fallback = { width: v.width, height: v.height };
        page.cleanup();
        await tick();
        initialized = true;
        await goTo(initial.page, initial.offset);
        if (!disposed) onInitialized();
      })
      .catch(onError);
    return () => {
      disposed = true;
      mounted = false;
      ro.disconnect();
      clearTimeout(selectionTimer);
      cancelAnimationFrame(scrollFrame);
      document.removeEventListener('selectionchange', selection);
      window.removeEventListener('keydown', keys);
    };
  });
</script>

<!-- Scroll region is keyboard focusable so arrow and page keys work. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="viewer"
  class:focus
  bind:this={scroller}
  onscroll={scroll}
  tabindex="0"
  role="region"
  aria-label="PDF document"
>
  {#if initialized}
    <div
      class="page-surface"
      style:height={(settings.mode === 'single'
        ? tops[current] - tops[current - 1]
        : tops[tops.length - 1]) + 'px'}
      style:width={surfaceWidth + 'px'}
    >
      {#each pages as n (n)}
        {@const dim = measured.get(n) ?? fallback}
        <PdfPage
          {pdf}
          page={n}
          scale={pageScale(dim)}
          rotation={settings.rotation}
          top={settings.mode === 'single' ? 10 : tops[n - 1] + 10}
          width={(settings.rotation % 180 ? dim.height : dim.width) * pageScale(dim)}
          height={(settings.rotation % 180 ? dim.width : dim.height) * pageScale(dim)}
          annotations={index ? JSON.parse(index.page(n)) : []}
          {queue}
          priority={Math.abs(n - current)}
          {regionMode}
          onSize={size}
          onReady={ready}
          {onError}
          onHit={hit}
          {onRegion}
        />
      {/each}
    </div>
  {/if}
</div>
