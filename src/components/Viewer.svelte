<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import PdfPage from './PdfPage.svelte';
  import { documentGestures, type Gesture } from '../lib/ink-touch';
  import type { InkSession } from '../lib/ink-session';
  import type { InkSettings } from '../lib/ink-types';
  import type { PDFDocumentProxy } from '../lib/pdf';
  import type { PageViewport } from 'pdfjs-dist';
  import type { Annotation, Progress, Rect } from '../lib/types';
  import { AnnotationIndex } from '../lib/core';
  import { RenderQueue } from '../lib/renderQueue';
  import { offsets, pageAt, type Size } from '../lib/virtual';
  import type { AnchorPosition, BoardAnchor } from '../lib/whiteboard-storage';
  import { selectionRects } from '../lib/geometry';
  let {
    pdf,
    initial,
    annotations,
    regionMode,
    focus,
    inkSession,
    inkSettings,
    onProgress,
    onInitialized,
    onSelection,
    onSelect,
    onRegion,
    onError,
    onMessage,
    attaching,
    anchors,
    onAttach,
    onOpenBoard,
    suspended,
  }: {
    pdf: PDFDocumentProxy;
    initial: Progress;
    annotations: Annotation[];
    regionMode: boolean;
    focus: boolean;
    inkSession: InkSession;
    inkSettings: InkSettings;
    onProgress: (p: Progress, immediate: boolean) => void;
    onInitialized: () => void;
    onSelection: (s: { page: number; rects: Rect[]; text: string } | null) => void;
    onSelect: (a: Annotation) => void;
    onRegion: (page: number, r: Rect) => void;
    onError: (e: unknown) => void;
    onMessage: (s: string) => void;
    attaching: boolean;
    anchors: (BoardAnchor & { title: string })[];
    onAttach: (position: AnchorPosition) => void;
    onOpenBoard: (anchor: BoardAnchor) => void;
    suspended: boolean;
  } = $props();
  let scroller: HTMLDivElement;
  let surface = $state<HTMLDivElement>();
  const pendingSizes = new Map<number, Size>();
  let zoomAnchor:
    | {
        page: number;
        x: number;
        y: number;
        zoom: number;
        originX: number;
        originY: number;
        left: number;
        top: number;
        right: number;
        bottom: number;
      }
    | undefined;
  const clampZoom = (zoom: number) => Math.max(0.25, Math.min(4, zoom));
  function beginZoom(center: { x: number; y: number }) {
    if (!surface || !initialized) return;
    const bounds = surface.getBoundingClientRect();
    const page = settings.mode === 'single' ? current : pageAt(tops, center.y - bounds.top);
    const dim = measured.get(page) ?? fallback;
    const zoom = pageScale(dim);
    const pageBounds = registry.get(page)?.el.getBoundingClientRect();
    const w = pageBounds?.width ?? (settings.rotation % 180 ? dim.height : dim.width) * zoom;
    const h = pageBounds?.height ?? (settings.rotation % 180 ? dim.width : dim.height) * zoom;
    const x = center.x - bounds.left;
    const y = center.y - bounds.top;
    zoomAnchor = {
      page,
      zoom,
      originX: x,
      originY: y,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      right: scroller.scrollWidth - scroller.clientWidth,
      bottom: scroller.scrollHeight - scroller.clientHeight,
      x: pageBounds ? (center.x - pageBounds.left) / w : (x - (bounds.width - w) / 2) / w,
      y: pageBounds
        ? (center.y - pageBounds.top) / h
        : (y - (settings.mode === 'single' ? 0 : tops[page - 1]) - 10) / h,
    };
    gesturing = true;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    onSelection(null);
  }
  function previewZoom(g: Gesture) {
    const a = zoomAnchor;
    if (!a || !surface) return;
    const factor = clampZoom(a.zoom * g.factor) / a.zoom;
    const k = Math.abs(factor - 1) < 0.015 ? 1 : factor;
    const x = g.x - g.start.x,
      y = g.y - g.start.y;
    const dx = k === 1 ? Math.max(a.left - a.right, Math.min(a.left, x)) : x + a.originX * (1 - k);
    const dy = k === 1 ? Math.max(a.top - a.bottom, Math.min(a.top, y)) : y + a.originY * (1 - k);
    surface.style.transform = `matrix(${k},0,0,${k},${dx},${dy})`;
  }
  async function endZoom(g: Gesture) {
    const a = zoomAnchor;
    if (!a || !surface) return;
    adjusting = true;
    const request = ++navigation;
    const zoom = clampZoom(a.zoom * g.factor);
    const resized = pendingSizes.size > 0;
    if (resized) {
      measured = new Map([...measured, ...pendingSizes]);
      pendingSizes.clear();
    }
    const changesScale = Math.abs(zoom / a.zoom - 1) >= 0.015;
    if (!changesScale && !resized) {
      surface.style.transform = '';
      scroller.scrollLeft = a.left + g.start.x - g.x;
      scroller.scrollTop = a.top + g.start.y - g.y;
    } else {
      if (changesScale) settings = { ...settings, zoom, fit: 'custom' };
      const bounds = scroller.getBoundingClientRect();
      const dim = measured.get(a.page) ?? fallback;
      const nextScale = pageScale(dim);
      const w = (settings.rotation % 180 ? dim.height : dim.width) * nextScale;
      const h = (settings.rotation % 180 ? dim.width : dim.height) * nextScale;
      const pageTop = settings.mode === 'single' ? 0 : tops[a.page - 1];
      scrollTop = Math.max(0, pageTop + 10 + a.y * h - (g.y - bounds.top));
      current = settings.mode === 'single' ? current : pageAt(tops, scrollTop);
      await tick();
      if (!mounted) return;
      surface.style.transform = '';
      if (request === navigation) {
        scroller.scrollLeft = (surface.offsetWidth - w) / 2 + a.x * w - (g.x - bounds.left);
        scroller.scrollTop = scrollTop;
      }
    }
    zoomAnchor = undefined;
    gesturing = false;
    if (request !== navigation) return;
    scrollTop = scroller.scrollTop;
    adjusting = false;
    report(true);
  }
  let width = $state(800),
    height = $state(800),
    scrollTop = $state(0);
  let settings = $state<Progress>(untrack(() => ({ ...initial })));
  let fallback = $state<Size>({ width: 612, height: 792 });
  let measured = $state.raw(new Map<number, Size>());
  let initialized = $state(false);
  let hidden = $state(document.hidden);
  let gesturing = $state(false);
  let index = $state<AnnotationIndex>();
  let current = $state(untrack(() => initial.page));
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
  const pageAnchors = $derived.by(() => {
    const map = new Map<number, typeof anchors>();
    for (const anchor of anchors) {
      const group = map.get(anchor.page);
      if (group) group.push(anchor);
      else map.set(anchor.page, [anchor]);
    }
    return map;
  });
  const scale = $derived(pageScale(measured.get(current) ?? fallback));
  const tops = $derived(offsets(pdf.numPages, measured, fallback, pageScale, settings.rotation));
  const firstVisible = $derived(pageAt(tops, scrollTop));
  const lastVisible = $derived(pageAt(tops, scrollTop + height));
  const pages = $derived.by(() => {
    if (settings.mode === 'single') return [current];
    const start = Math.max(1, firstVisible - 1);
    const end = Math.min(pdf.numPages, lastVisible + 1, start + 8);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i).sort(
      (a, b) => Math.abs(a - current) - Math.abs(b - current),
    );
  });
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
  export async function goTo(n: number, offset = 0, horizontal = 0) {
    document.dispatchEvent(new Event('ink-finish'));
    const request = ++navigation;
    const target = Math.max(1, Math.min(pdf.numPages, Math.round(n)));
    current = target;
    adjusting = true;
    onSelection(null);
    scrollTop =
      (settings.mode === 'single' ? 0 : Math.ceil(tops[target - 1])) +
      offset * (tops[target] - tops[target - 1] - 20);
    await tick();
    if (!mounted || request !== navigation) return;
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = horizontal * (scroller.scrollWidth - scroller.clientWidth);
    scrollTop = scroller.scrollTop;
    adjusting = false;
    report(true);
  }
  export async function configure(change: Partial<Progress>) {
    document.dispatchEvent(new Event('ink-finish'));
    const saved = capture();
    settings = { ...settings, ...change };
    await tick();
    await goTo(saved.page, saved.offset, saved.horizontal);
  }
  export function capture(): Progress {
    const n = settings.mode === 'single' ? current : pageAt(tops, scroller?.scrollTop ?? scrollTop);
    const local =
      (scroller?.scrollTop ?? scrollTop) - (settings.mode === 'single' ? 0 : tops[n - 1]);
    const scrollRange = scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
    return {
      ...settings,
      page: n,
      horizontal: scrollRange ? Math.max(0, Math.min(1, scroller.scrollLeft / scrollRange)) : 0,
      offset: Math.max(0, Math.min(1, local / (tops[n] - tops[n - 1] - 20))),
      zoom: settings.fit === 'custom' ? settings.zoom : Math.max(0.25, Math.min(4, scale)),
    };
  }
  function report(immediate = false) {
    if (initialized) {
      const p = capture();
      current = p.page;
      onProgress(p, immediate);
    }
  }
  function scroll() {
    if (adjusting || zoomAnchor) return;
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (adjusting || zoomAnchor) return;
      scrollTop = scroller.scrollTop;
      report();
    });
  }
  async function size(n: number, w: number, h: number) {
    const old = measured.get(n) ?? fallback;
    if (old.width === w && old.height === h) return;
    if (zoomAnchor) {
      pendingSizes.set(n, { width: w, height: h });
      return;
    }
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
    if (inkSettings.tool !== 'text' || suspended || zoomAnchor) return;
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
    if (!initialized || suspended || e.defaultPrevented) return;
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
          if (!disposed) void goTo(p.page, p.offset, p.horizontal);
        });
    });
    ro.observe(scroller);
    const visibility = () => {
      hidden = document.hidden;
    };
    document.addEventListener('visibilitychange', visibility);
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
        await goTo(initial.page, initial.offset, initial.horizontal);
        if (!disposed) onInitialized();
      })
      .catch(onError);
    return () => {
      disposed = true;
      mounted = false;
      ro.disconnect();
      clearTimeout(selectionTimer);
      cancelAnimationFrame(scrollFrame);
      document.removeEventListener('visibilitychange', visibility);
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
  use:documentGestures={{
    settings: () => inkSettings,
    session: inkSession,
    onError,
    singleAction: () => regionMode || attaching,
    pan: (dx, dy) => {
      scroller.scrollLeft += dx;
      scroller.scrollTop += dy;
    },
    begin: beginZoom,
    preview: previewZoom,
    end: endZoom,
  }}
  bind:this={scroller}
  onscroll={scroll}
  tabindex="0"
  role="region"
  aria-label="PDF document"
>
  {#if initialized}
    <div
      class="page-surface"
      bind:this={surface}
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
          paused={hidden || suspended || gesturing}
          priority={Math.abs(n - current)}
          {regionMode}
          {attaching}
          anchors={pageAnchors.get(n) ?? []}
          {onAttach}
          {onOpenBoard}
          {inkSession}
          {inkSettings}
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
