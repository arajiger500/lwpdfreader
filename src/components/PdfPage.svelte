<script lang="ts">
  import Icon from './Icon.svelte';
  import type { AnchorPosition, BoardAnchor } from '../lib/whiteboard-storage';
  import InkLayer from './InkLayer.svelte';
  import type { InkSession } from '../lib/ink-session';
  import { writingTool, type InkSettings } from '../lib/ink-types';
  import { onDestroy, untrack } from 'svelte';
  import { pdfEngine, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from '../lib/pdf';
  import type { PageViewport, TextLayer } from 'pdfjs-dist';
  import type { Annotation, Rect } from '../lib/types';
  import type { RenderQueue } from '../lib/renderQueue';
  import { normalizedToScreen, screenToNormalized } from '../lib/geometry';
  let {
    pdf,
    page,
    scale,
    rotation,
    top,
    width,
    height,
    annotations,
    queue,
    paused,
    priority,
    regionMode,
    attaching,
    anchors,
    onAttach,
    onOpenBoard,
    inkSession,
    inkSettings,
    onSize,
    onReady,
    onError,
    onHit,
    onRegion,
  }: {
    pdf: PDFDocumentProxy;
    page: number;
    scale: number;
    rotation: number;
    top: number;
    width: number;
    height: number;
    annotations: Annotation[];
    queue: RenderQueue;
    paused: boolean;
    priority: number;
    regionMode: boolean;
    attaching: boolean;
    anchors: (BoardAnchor & { title: string })[];
    onAttach: (position: AnchorPosition) => void;
    onOpenBoard: (anchor: BoardAnchor) => void;
    inkSession: InkSession;
    inkSettings: InkSettings;
    onSize: (n: number, w: number, h: number) => void;
    onReady: (n: number, el: HTMLElement | null, viewport?: PageViewport, box?: number[]) => void;
    onError: (e: unknown) => void;
    onHit: (page: number, x: number, y: number) => void;
    onRegion: (page: number, rect: Rect) => void;
  } = $props();
  let host: HTMLDivElement;
  let raster: HTMLDivElement;
  let text: HTMLDivElement;
  let pageProxy = $state.raw<PDFPageProxy>();
  const viewport = $derived(
    pageProxy?.getViewport({ scale, rotation: (pageProxy.rotate + rotation) % 360 }),
  );
  const box = $derived(pageProxy?.view ?? []);
  let rendered = $state(false);
  let noText = $state(false);
  let failed = $state(false);
  let drag = $state<{ x: number; y: number; endX: number; endY: number }>();
  let displayed: HTMLCanvasElement | undefined;
  let displayedKey = '';
  let displayedRotation: number | undefined;
  let textLayer: TextLayer | undefined;
  let disposed = false;

  function layoutText(v: PageViewport) {
    text.style.setProperty('--total-scale-factor', String(v.scale));
    // Explicit unrotated dimensions also work in WebKit versions without CSS round().
    text.style.width = (v.rotation % 180 ? v.height : v.width) + 'px';
    text.style.height = (v.rotation % 180 ? v.width : v.height) + 'px';
  }
  $effect(() => {
    const v = viewport;
    if (!v) return;
    layoutText(v);
    textLayer?.update({ viewport: v });
    raster.style.visibility = displayedRotation === v.rotation ? '' : 'hidden';
    if (textLayer) onReady(page, host, v, box);
  });

  $effect(() => {
    const doc = pdf,
      n = page,
      s = scale,
      r = rotation;
    const key = s + ':' + r;
    if (paused || (displayedKey === key && textLayer)) return;
    const controller = new AbortController();
    let task: RenderTask | undefined;
    let layer: TextLayer | undefined;
    let staged: HTMLCanvasElement | undefined;
    let continuation = 0;
    rendered = false;
    failed = false;
    const started = performance.now();
    void queue
      .run(
        untrack(() => priority),
        controller.signal,
        async () => {
          const localPage = await (untrack(() => pageProxy) ?? doc.getPage(n));
          if (controller.signal.aborted) return;
          pageProxy = localPage;
          const native = localPage.getViewport({ scale: 1, rotation: localPage.rotate });
          onSize(n, native.width, native.height);
          const v = localPage.getViewport({ scale: s, rotation: (localPage.rotate + r) % 360 });
          if (displayedKey !== key) {
            const ratio = Math.min(
              window.devicePixelRatio || 1,
              2,
              Math.sqrt(4_000_000 / (v.width * v.height)),
              4096 / v.width,
              4096 / v.height,
            );
            const canvas = (staged = document.createElement('canvas'));
            canvas.width = Math.max(1, Math.floor(v.width * ratio));
            canvas.height = Math.max(1, Math.floor(v.height * ratio));
            canvas.setAttribute('aria-label', 'PDF page ' + n);
            task = localPage.render({ canvas, viewport: v, transform: [ratio, 0, 0, ratio, 0, 0] });
            task.onContinue = (resume: () => void) => {
              continuation = requestAnimationFrame(() => {
                if (!controller.signal.aborted) resume();
              });
            };
            try {
              await task.promise;
            } finally {
              if (disposed) localPage.cleanup();
            }
            if (controller.signal.aborted) return;
            raster.replaceChildren(canvas);
            if (displayed) displayed.width = displayed.height = 0;
            displayed = canvas;
            displayedKey = key;
            displayedRotation = v.rotation;
            raster.style.visibility = '';
            staged = undefined;
          }
          if (!textLayer) {
            const { TextLayer } = await pdfEngine();
            if (controller.signal.aborted) return;
            text.replaceChildren();
            layoutText(v);
            layer = new TextLayer({
              textContentSource: localPage.streamTextContent(),
              container: text,
              viewport: v,
            });
            layoutText(v);
            await layer.render();
            if (controller.signal.aborted) return;
            noText = layer.textContentItemsStr.every((item) => !item.trim());
            textLayer = layer;
            layer = undefined;
          }
          rendered = true;
          onReady(n, host, v, localPage.view);
          host.dataset.renderMs = (performance.now() - started).toFixed(1);
          host.dispatchEvent(
            new CustomEvent('page-rendered', {
              bubbles: true,
              detail: { page: n, ms: performance.now() - started },
            }),
          );
        },
      )
      .catch((error) => {
        if (!controller.signal.aborted) {
          failed = true;
          onError(error);
        }
      });
    return () => {
      controller.abort();
      cancelAnimationFrame(continuation);
      task?.cancel();
      layer?.cancel();
      if (staged) staged.width = staged.height = 0;
    };
  });
  onDestroy(() => {
    disposed = true;
    if (displayed) displayed.width = displayed.height = 0;
    onReady(page, null);
    pageProxy?.cleanup();
  });
  function click(e: MouseEvent) {
    if (!viewport || regionMode) return;
    if (!attaching && (writingTool(inkSettings.tool) || !window.getSelection()?.isCollapsed))
      return;
    const b = host.getBoundingClientRect();
    const [x, y] = viewport.convertToPdfPoint(e.clientX - b.left, e.clientY - b.top);
    const nx = (x - box[0]) / (box[2] - box[0]),
      ny = (y - box[1]) / (box[3] - box[1]);
    if (attaching)
      onAttach({ page, x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) });
    else onHit(page, nx, ny);
  }
  function pointerDown(e: PointerEvent) {
    if (!regionMode || !viewport) return;
    e.preventDefault();
    host.setPointerCapture(e.pointerId);
    const b = host.getBoundingClientRect();
    drag = {
      x: e.clientX - b.left,
      y: e.clientY - b.top,
      endX: e.clientX - b.left,
      endY: e.clientY - b.top,
    };
  }
  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const b = host.getBoundingClientRect();
    drag = {
      ...drag,
      endX: Math.max(0, Math.min(b.width, e.clientX - b.left)),
      endY: Math.max(0, Math.min(b.height, e.clientY - b.top)),
    };
  }
  function pointerUp() {
    if (drag && viewport) {
      const d = drag;
      drag = undefined;
      if (Math.abs(d.endX - d.x) > 4 && Math.abs(d.endY - d.y) > 4)
        onRegion(
          page,
          screenToNormalized(
            {
              left: Math.min(d.x, d.endX),
              right: Math.max(d.x, d.endX),
              top: Math.min(d.y, d.endY),
              bottom: Math.max(d.y, d.endY),
            },
            viewport,
            box,
          ),
        );
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
<div
  class:region-mode={regionMode}
  class:attaching
  class:inking={writingTool(inkSettings.tool)}
  class:hand-mode={inkSettings.tool === 'hand'}
  class="pdf-page"
  data-page={page}
  data-rendered={rendered}
  bind:this={host}
  style:top={top + 'px'}
  style:width={(viewport?.width ?? width) + 'px'}
  style:height={(viewport?.height ?? height) + 'px'}
  role="group"
  aria-label={'Page ' + page}
  onclick={click}
  onkeydown={(e) => {
    if (e.key === 'Escape') window.getSelection()?.removeAllRanges();
  }}
  onpointerdown={pointerDown}
  onpointermove={pointerMove}
  onpointerup={pointerUp}
  onpointercancel={() => (drag = undefined)}
  onlostpointercapture={() => (drag = undefined)}
>
  {#if !rendered}<div class="page-loading">
      {failed ? 'Page could not be rendered' : 'Loading page ' + page + '…'}
    </div>{/if}
  <div class="page-raster" bind:this={raster}></div>
  <div class="highlights" aria-hidden="true">
    {#if viewport}{#each annotations.filter((a) => a.kind === 'highlight') as a (a.id)}{#each a.rects as r}{@const s =
            normalizedToScreen(r, viewport, box)}
          <div
            class={'highlight ' + a.color}
            data-annotation={a.id}
            style:left={s.left + 'px'}
            style:top={s.top + 'px'}
            style:width={s.width + 'px'}
            style:height={s.height + 'px'}
          ></div>{/each}{/each}{/if}
  </div>
  <div class="textLayer" bind:this={text}></div>
  {#if viewport}<InkLayer
      session={inkSession}
      {page}
      {viewport}
      {box}
      settings={attaching ? { ...inkSettings, tool: 'hand' } : inkSettings}
      {onError}
    />{/if}
  {#if viewport}
    {#each anchors as anchor (anchor.id)}
      {@const [x, y] = viewport.convertToViewportPoint(
        box[0] + anchor.x * (box[2] - box[0]),
        box[1] + anchor.y * (box[3] - box[1]),
      )}
      <button
        class="board-marker"
        aria-label={'Open whiteboard: ' + anchor.title}
        title={anchor.title}
        style:left={x + 'px'}
        style:top={y + 'px'}
        onclick={(e) => {
          e.stopPropagation();
          onOpenBoard(anchor);
        }}
      >
        <Icon name="whiteboard" size={14} />
      </button>
    {/each}
  {/if}
  {#if noText}<div class="no-text">Image-only page · Use Region highlight to mark an area</div>{/if}
  {#if drag}<div
      class="region-draft"
      style:left={Math.min(drag.x, drag.endX) + 'px'}
      style:top={Math.min(drag.y, drag.endY) + 'px'}
      style:width={Math.abs(drag.endX - drag.x) + 'px'}
      style:height={Math.abs(drag.endY - drag.y) + 'px'}
    ></div>{/if}
</div>
