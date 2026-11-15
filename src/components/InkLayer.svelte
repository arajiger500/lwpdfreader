<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { PageViewport } from 'pdfjs-dist';
  import { InkEraser } from '../lib/core';
  import type { InkSession, InkPageState } from '../lib/ink-session';
  import {
    writingTool,
    strokeOrder,
    type InkSettings,
    type InkPoint,
    type Stroke,
  } from '../lib/ink-types';
  import { inkPoint, centerPath, penOutline, groupStrokes } from '../lib/ink-geometry';
  import InkStroke from './InkStroke.svelte';
  let {
    session,
    page,
    viewport,
    box,
    settings,
    onError,
  }: {
    session: InkSession;
    page: number;
    viewport: PageViewport;
    box: number[];
    settings: InkSettings;
    onError: (e: unknown) => void;
  } = $props();
  let pageData = $state.raw<InkPageState>({ strokes: [], loaded: false, error: null });
  let preview = $state.raw<Stroke[] | null>(null);
  let svg: SVGSVGElement,
    draft: SVGGElement,
    markerDraft: SVGGElement,
    markerPath: SVGPathElement,
    markerDot: SVGCircleElement,
    path: SVGPathElement,
    dot: SVGCircleElement,
    cursor: SVGCircleElement;
  let pointer: number | null = null,
    pointerType = '',
    points: InkPoint[] = [],
    capturedSettings: InkSettings;
  let erase: InkEraser | undefined;
  let eraseBatch: InkPoint[] = [],
    base: Stroke[] = [];
  let replacements: { id: string; segments: InkPoint[][] }[] = [];
  let frame = 0,
    startTime = 0,
    rootId = '',
    strokeId = '',
    beganBounds: DOMRect;
  let capturedViewport: PageViewport, capturedBox: number[];
  const groups = $derived(groupStrokes(preview ?? pageData.strokes));
  const transform = $derived(`matrix(${viewport.transform.join(' ')})`);
  const enabled = $derived(writingTool(settings.tool));
  onMount(() => {
    const off = session.subscribePage(page, (value) => (pageData = value));
    const finishEvent = () => finish(false);
    const visibility = () => {
      if (document.visibilityState === 'hidden') finish(false);
    };
    document.addEventListener('ink-finish', finishEvent);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', finishEvent);
    return () => {
      off();
      document.removeEventListener('ink-finish', finishEvent);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', finishEvent);
    };
  });
  onDestroy(() => {
    finish(false);
    cancelAnimationFrame(frame);
    erase?.free();
  });
  // A zoom/rotation change finalizes the old coordinate space first.
  $effect(() => {
    const v = viewport;
    const tool = settings.tool;
    return () => {
      void v;
      void tool;
      finish(false);
    };
  });
  function point(e: PointerEvent): InkPoint {
    const pressure =
      e.pointerType === 'pen' && e.pressure > 0 && e.pressure <= 1
        ? e.pressure
        : (points.at(-1)?.pressure ?? null);
    return inkPoint(e.clientX, e.clientY, beganBounds, capturedViewport, capturedBox, pressure);
  }
  function down(e: PointerEvent) {
    if (!enabled || pointer !== null || e.button !== 0) return;
    if (
      e.pointerType === 'touch' &&
      (!settings.fingerDrawing ||
        session.penActive ||
        performance.now() - session.penFinishedAt < 450)
    )
      return;
    if (!pageData.loaded || pageData.error || session.inputBlocked) {
      onError(
        new Error(
          session.failed
            ? 'Ink is not saved. Use Retry ink before drawing again.'
            : session.inputBlocked
              ? 'Undo or redo is still finishing. Wait before drawing.'
              : 'Ink is still loading. Wait before drawing.',
        ),
      );
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();
    pointer = e.pointerId;
    pointerType = e.pointerType;
    capturedSettings = { ...settings };
    capturedViewport = viewport;
    capturedBox = [...box];
    beganBounds = svg.getBoundingClientRect();
    startTime = pageData.strokes.reduce((time, s) => Math.max(time, s.createdAt + 1), Date.now());
    rootId = crypto.randomUUID();
    strokeId = rootId;
    points = [];
    if (e.pointerType === 'pen') session.penActive = true;
    try {
      svg.setPointerCapture(e.pointerId);
      points.push(point(e));
      if (settings.tool === 'eraser') {
        base = pageData.strokes;
        erase = new InkEraser(JSON.stringify(base));
        eraseBatch = [points[0]];
        replacements = [];
      }
      schedule();
    } catch (error) {
      pointer = null;
      session.penActive = false;
      erase?.free();
      erase = undefined;
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* no capture */
      }
      onError(error);
    }
  }
  function move(e: PointerEvent) {
    if (pointer !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (session.failed) {
      finish(false);
      return;
    }
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const sample of events.length ? events : [e]) {
      let p = point(sample);
      const last = points.at(-1)!;
      if (capturedSettings.smoothing && capturedSettings.tool !== 'eraser')
        p = { ...p, x: last.x + (p.x - last.x) * 0.65, y: last.y + (p.y - last.y) * 0.65 };
      if (Math.hypot((p.x - last.x) * (box[2] - box[0]), (p.y - last.y) * (box[3] - box[1])) < 0.08)
        continue;
      points.push(p);
      if (erase) {
        eraseBatch.push(p);
        if (points.length > 2) points.shift();
        if (eraseBatch.length >= 4096) paint();
      }
      if (points.length >= 8180) {
        finish(false, true);
      }
    }
    schedule();
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(paint);
  }
  function paint() {
    frame = 0;
    if (pointer === null) return;
    const w = capturedBox[2] - capturedBox[0],
      h = capturedBox[3] - capturedBox[1],
      x = capturedBox[0],
      y = capturedBox[1];
    if (erase) {
      if (eraseBatch.length) {
        const batch = eraseBatch;
        eraseBatch = [];
        const result = JSON.parse(
          erase.erase(
            JSON.stringify(batch),
            capturedSettings.eraserSize / 2,
            capturedSettings.eraserMode,
            capturedSettings.eraserTarget,
          ),
        ) as { replacements: typeof replacements };
        replacements = result.replacements;
        const map = new Map(replacements.map((r) => [r.id, r]));
        preview = base
          .flatMap((s) => {
            const r = map.get(s.id);
            return r
              ? r.segments.map((segment, i) => ({
                  ...s,
                  id: s.id + ':preview:' + i,
                  points: segment,
                }))
              : [s];
          })
          .sort(strokeOrder);
      }
      const p = points.at(-1)!;
      cursor.setAttribute('cx', String(x + p.x * w));
      cursor.setAttribute('cy', String(y + p.y * h));
      cursor.setAttribute('r', String(capturedSettings.eraserSize / 2));
      cursor.style.display = '';
      return;
    }
    const width =
      capturedSettings.tool === 'marker' ? capturedSettings.markerWidth : capturedSettings.penWidth;
    const color =
      capturedSettings.tool === 'marker' ? capturedSettings.markerColor : capturedSettings.penColor;
    const targetDraft = capturedSettings.tool === 'marker' ? markerDraft : draft;
    const targetPath = capturedSettings.tool === 'marker' ? markerPath : path;
    const targetDot = capturedSettings.tool === 'marker' ? markerDot : dot;
    targetDraft.setAttribute('opacity', capturedSettings.tool === 'marker' ? '.28' : '1');

    const pressure =
      capturedSettings.tool === 'pen' &&
      points.some((p) => p.pressure !== null && p.pressure !== 0.5);
    targetPath.setAttribute(
      'd',
      pressure ? penOutline(points, w, h, width, x, y) : centerPath(points, w, h, x, y),
    );
    targetPath.setAttribute('fill', pressure ? color : 'none');
    targetPath.setAttribute('stroke', pressure ? 'none' : color);
    targetPath.setAttribute('stroke-width', String(width));
    const p = points[0];
    targetDot.setAttribute('cx', String(x + p.x * w));
    targetDot.setAttribute('cy', String(y + p.y * h));
    targetDot.setAttribute('r', String(width / 2));
    targetDot.setAttribute('fill', color);
    targetDot.style.display = points.length === 1 && !pressure ? '' : 'none';
  }
  function finish(cancelled: boolean, continuing = false) {
    if (pointer === null) return;
    cancelAnimationFrame(frame);
    frame = 0;
    paint();
    const id = pointer;
    const tail = points.at(-1)!;
    pointer = null;
    try {
      if (!(cancelled && pointerType === 'touch')) {
        if (erase) {
          const before = base.filter((s) => replacements.some((r) => r.id === s.id));
          const after = before.flatMap((s) =>
            replacements
              .find((r) => r.id === s.id)!
              .segments.map((segment) => ({
                ...s,
                id: crypto.randomUUID(),
                points: segment,
                updatedAt: Math.max(Date.now(), s.createdAt, s.updatedAt + 1),
              })),
          );
          session.commit({ documentId: session.documentId, page, before, after }, true);
        } else if (points.length) {
          const variable =
            pointerType === 'pen' && points.some((p) => p.pressure !== null && p.pressure !== 0.5);
          const kind = capturedSettings.tool === 'marker' ? 'marker' : 'pen';
          const stroke: Stroke = {
            version: 1,
            id: strokeId,
            rootId,
            documentId: session.documentId,
            page,
            kind,
            color: kind === 'marker' ? capturedSettings.markerColor : capturedSettings.penColor,
            width:
              (kind === 'marker' ? capturedSettings.markerWidth : capturedSettings.penWidth) /
              Math.min(capturedBox[2] - capturedBox[0], capturedBox[3] - capturedBox[1]),
            opacity: kind === 'marker' ? 0.28 : 1,
            pageWidth: capturedBox[2] - capturedBox[0],
            pageHeight: capturedBox[3] - capturedBox[1],
            points: points.map((p) => ({ ...p, pressure: variable ? p.pressure : null })),
            createdAt: startTime,
            updatedAt: Math.max(Date.now(), startTime),
          };
          session.commit(
            { documentId: session.documentId, page, before: [], after: [stroke] },
            true,
          );
        }
      }
    } catch (e) {
      onError(e);
    } finally {
      erase?.free();
      erase = undefined;
      preview = null;
      points = [];
      replacements = [];
      path?.setAttribute('d', '');
      markerPath?.setAttribute('d', '');
      if (markerDot) markerDot.style.display = 'none';
      if (dot) dot.style.display = 'none';
      if (cursor) cursor.style.display = 'none';
      if (continuing && !session.failed) {
        pointer = id;
        points = [tail];
        strokeId = crypto.randomUUID();
        return;
      }
      if (pointerType === 'pen') {
        session.penActive = false;
        session.penFinishedAt = performance.now();
      }
      try {
        if (svg?.hasPointerCapture(id)) svg.releasePointerCapture(id);
      } catch {
        /* detached */
      }
    }
  }
</script>

<svg
  class="ink-marker-layer"
  viewBox={`0 0 ${viewport.width} ${viewport.height}`}
  aria-hidden="true"
>
  <g {transform}>
    {#each groups.filter((g) => g.kind === 'marker') as group (group.rootId)}<g
        opacity={group.opacity}
        data-ink-kind="marker"
        >{#each group.strokes as stroke (stroke.id)}<InkStroke {stroke} {box} />{/each}</g
      >{/each}
    <g bind:this={markerDraft}
      ><path bind:this={markerPath} stroke-linecap="round" stroke-linejoin="round" /><circle
        bind:this={markerDot}
        style="display:none"
      /></g
    >
  </g>
</svg>
<!-- Drawing is also available with mouse and optional finger input; tool buttons are keyboard accessible. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg
  class="ink-layer"
  class:ink-interactive={enabled}
  bind:this={svg}
  viewBox={`0 0 ${viewport.width} ${viewport.height}`}
  aria-label={'Freehand annotations on page ' + page}
  data-ink-loaded={pageData.loaded}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={(e) => {
    if (pointer === e.pointerId) {
      e.stopPropagation();
      const end = point(e),
        last = points.at(-1)!;
      if (Math.hypot(end.x - last.x, end.y - last.y) > 1e-6) {
        points.push(end);
        if (erase) eraseBatch.push(end);
      }
      finish(false);
    }
  }}
  onpointercancel={(e) => {
    if (pointer === e.pointerId) finish(true);
  }}
  onlostpointercapture={(e) => {
    if (pointer === e.pointerId) finish(true);
  }}
>
  <g {transform}>
    {#each groups.filter((g) => g.kind === 'pen') as group (group.rootId)}<g
        opacity={group.opacity}
        style:mix-blend-mode={group.kind === 'marker' ? 'multiply' : 'normal'}
        data-ink-kind={group.kind}
        >{#each group.strokes as stroke (stroke.id)}<InkStroke {stroke} {box} />{/each}</g
      >{/each}
    <g bind:this={draft}
      ><path bind:this={path} stroke-linecap="round" stroke-linejoin="round" /><circle
        bind:this={dot}
        style="display:none"
      /></g
    >
    <circle
      bind:this={cursor}
      fill="#ffffff44"
      stroke="#333"
      stroke-width="0.7"
      style="display:none"
    />
  </g>
</svg>
