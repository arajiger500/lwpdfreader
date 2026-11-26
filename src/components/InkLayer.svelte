<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { InkFilter } from '../lib/ink-filter';
  import { InkEraser } from '../lib/core';
  import type { InkSession, InkPageState } from '../lib/ink-session';
  import {
    writingTool,
    strokeOrder,
    type InkSettings,
    type InkPoint,
    type Stroke,
  } from '../lib/ink-types';
  import {
    inkPoint,
    centerPath,
    penOutline,
    groupStrokes,
    type InkViewport,
  } from '../lib/ink-geometry';
  import InkStroke from './InkStroke.svelte';
  let {
    session,
    page,
    viewport,
    box,
    settings,
    onError,
    visibleStrokes,
    eraserStrokes,
  }: {
    session: InkSession;
    page: number;
    viewport: InkViewport;
    box: number[];
    settings: InkSettings;
    onError: (e: unknown) => void;
    visibleStrokes?: (strokes: Stroke[]) => Stroke[];
    eraserStrokes?: (strokes: Stroke[], whole: boolean) => Stroke[];
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
  const liveChunkSize = 192;
  const liveChunks: SVGPathElement[] = [];
  let renderedPoints = 0;
  let previousErase = '';
  let frame = 0,
    startTime = 0,
    rootId = '',
    strokeId = '',
    beganBounds: DOMRect;
  let capturedViewport: InkViewport, capturedBox: number[];
  let filter: InkFilter;
  let touchFragments: Stroke[] = [];
  const candidates = $derived(visibleStrokes ? visibleStrokes(pageData.strokes) : pageData.strokes);
  const groups = $derived(groupStrokes(preview ?? candidates));
  const transform = $derived(`matrix(${viewport.transform.join(' ')})`);
  const enabled = $derived(writingTool(settings.tool));
  onMount(() => {
    const off = session.subscribePage(page, (value) => (pageData = value));
    const finishEvent = () => finish(pointerType === 'touch');
    const cancelTouch = () => {
      if (pointerType === 'touch') finish(true);
    };
    svg.addEventListener('ink-cancel-touch', cancelTouch);
    const visibility = () => {
      if (document.visibilityState === 'hidden') finishEvent();
    };
    document.addEventListener('ink-finish', finishEvent);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', finishEvent);
    return () => {
      off();
      svg.removeEventListener('ink-cancel-touch', cancelTouch);
      document.removeEventListener('ink-finish', finishEvent);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', finishEvent);
    };
  });
  onDestroy(() => {
    finish(pointerType === 'touch');
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
      finish(pointerType === 'touch');
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
    startTime = Math.max(Date.now(), (pageData.strokes.at(-1)?.createdAt ?? 0) + 1);
    rootId = crypto.randomUUID();
    strokeId = rootId;
    points = [];
    touchFragments = [];
    const [a, b, c, d] = viewport.transform;
    filter = new InkFilter(
      settings.tool === 'eraser' ? 'off' : settings.stabilization,
      Math.hypot(a, b) * (box[2] - box[0]),
      Math.hypot(c, d) * (box[3] - box[1]),
    );
    if (e.pointerType === 'pen') session.penActive = true;
    try {
      svg.setPointerCapture(e.pointerId);
      points.push(filter.sample(point(e), e.timeStamp));
      if (e.pointerType !== 'touch') {
        startErase();
        schedule();
      }
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
  function startErase() {
    if (capturedSettings.tool !== 'eraser' || erase) return;
    base = eraserStrokes
      ? eraserStrokes(pageData.strokes, capturedSettings.eraserMode === 'stroke')
      : candidates;
    erase = new InkEraser(JSON.stringify(base));
    eraseBatch = [...points];
    replacements = [];
    previousErase = '';
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
      const p = filter.sample(point(sample), sample.timeStamp);
      const last = points.at(-1)!;
      if (Math.hypot((p.x - last.x) * (box[2] - box[0]), (p.y - last.y) * (box[3] - box[1])) < 0.08)
        continue;
      points.push(p);
      if (capturedSettings.tool === 'eraser') {
        if (erase) eraseBatch.push(p);
        else {
          try {
            startErase();
          } catch (error) {
            onError(error);
            finish(true);
            return;
          }
        }
        if (points.length > 2) points.shift();
        if (eraseBatch.length >= 4096) paint();
      }
      if (points.length >= 8180) {
        finish(false, true);
      }
    }
    if (points.length > 1) schedule();
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
        const result = erase.erase(
          JSON.stringify(batch),
          capturedSettings.eraserSize / 2,
          capturedSettings.eraserMode,
          capturedSettings.eraserTarget,
        );
        if (result !== previousErase) {
          previousErase = result;
          replacements = (JSON.parse(result) as { replacements: typeof replacements }).replacements;
          const changed = new Map(replacements.map((replacement) => [replacement.id, replacement]));
          preview = changed.size
            ? base
                .flatMap((stroke) => {
                  const replacement = changed.get(stroke.id);
                  return replacement
                    ? replacement.segments.map((segment, index) => ({
                        ...stroke,
                        id: stroke.id + ':preview:' + index,
                        points: segment,
                      }))
                    : [stroke];
                })
                .sort(strokeOrder)
            : null;
        }
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

    const pressure = capturedSettings.tool === 'pen' && pointerType === 'pen';
    const draw = (node: SVGPathElement, samples: InkPoint[]) => {
      node.setAttribute(
        'd',
        pressure ? penOutline(samples, w, h, width, x, y) : centerPath(samples, w, h, x, y),
      );
      node.setAttribute('fill', pressure ? color : 'none');
      node.setAttribute('stroke', pressure ? 'none' : color);
      node.setAttribute('stroke-width', String(width));
    };
    // Seal older geometry as the pointer moves. A shared sample joins chunks;
    // a marker's parent group applies opacity once.
    while (points.length - renderedPoints > liveChunkSize + 1) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      draw(path, points.slice(renderedPoints, renderedPoints + liveChunkSize + 1));
      renderedPoints += liveChunkSize;
      targetDraft.insertBefore(path, targetPath);
      liveChunks.push(path);
    }
    draw(targetPath, points.slice(renderedPoints));
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
    const id = pointer;
    const tail = points.at(-1)!;
    try {
      if (!(cancelled && pointerType === 'touch')) {
        startErase();
        paint();
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
          if (pointerType === 'touch') touchFragments.push(stroke);
          if (pointerType !== 'touch' || !continuing) {
            session.commit(
              {
                documentId: session.documentId,
                page,
                before: [],
                after: pointerType === 'touch' ? touchFragments : [stroke],
              },
              true,
            );
          }
        }
      }
    } catch (e) {
      onError(e);
    } finally {
      pointer = null;
      erase?.free();
      erase = undefined;
      preview = null;
      points = [];
      replacements = [];
      const keepTouchDraft = continuing && pointerType === 'touch' && !session.failed;
      if (keepTouchDraft) {
        const target = capturedSettings.tool === 'marker' ? markerPath : path;
        const tail = target.cloneNode() as SVGPathElement;
        target.before(tail);
        liveChunks.push(tail);
      } else {
        for (const node of liveChunks) node.remove();
        liveChunks.length = 0;
      }
      renderedPoints = 0;
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
      touchFragments = [];
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
      const end = filter.sample(point(e), e.timeStamp, true),
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
