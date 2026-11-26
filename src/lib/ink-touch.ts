import type { InkSession } from './ink-session';
import { writingTool, type InkSettings } from './ink-types';

type Point = { x: number; y: number };
export interface Gesture extends Point {
  start: Point;
  factor: number;
}
interface Options {
  settings: () => InkSettings;
  session: InkSession;
  onError: (error: unknown) => void;
  singleAction?: () => boolean;
  pan: (dx: number, dy: number) => void;
  begin: (center: Point) => void;
  preview: (gesture: Gesture) => void;
  end: (gesture: Gesture) => void | Promise<void>;
}
const position = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

type Phase = 'idle' | 'tap' | 'ink' | 'pan' | 'pinch' | 'drain';

/** The surface owns navigation. Ink owns provisional samples until a second
 * contact takes over. A broken pair drains remaining contacts before drawing. */
export function documentGestures(node: HTMLElement, options: Options) {
  const listeners = new AbortController();
  const touches = new Map<number, Point>();
  let phase: Phase = 'idle';
  let origin: Point;
  let inkTarget: EventTarget | null;
  let pair: [number, number];
  let span = 1;
  let gesture: Gesture;
  let frame = 0;
  let settling = false;
  let suppressClick = false;

  function capture(id: number) {
    try {
      node.setPointerCapture(id);
    } catch {
      // A canceled or synthetic pointer may no longer be available.
    }
  }
  function consume(e: Event) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function paint() {
    frame = 0;
    options.preview(gesture);
  }
  function finish() {
    if (phase !== 'pinch') return;
    cancelAnimationFrame(frame);
    frame = 0;
    phase = 'drain';
    settling = true;
    void Promise.resolve(options.end(gesture))
      .catch((error) => {
        options.onError(error);
      })
      .finally(() => {
        settling = false;
        if (!touches.size) phase = 'idle';
      });
  }
  function reset() {
    finish();
    for (const id of touches.keys()) {
      if (node.hasPointerCapture(id)) {
        node.releasePointerCapture(id);
      }
    }
    touches.clear();
    inkTarget = null;
    phase = settling ? 'drain' : 'idle';
  }
  function down(e: PointerEvent) {
    const touch = e.pointerType === 'touch';
    const settings = options.settings();
    const button = (e.target as Element).closest('button');
    const mouseHand =
      e.pointerType === 'mouse' && settings.tool === 'hand' && !button && !options.singleAction?.();
    if (e.button !== 0) return;
    if (!touch && !mouseHand) {
      if (phase === 'pinch' || settling) consume(e);
      else if (e.pointerType === 'pen' && touches.size) {
        if (phase === 'ink') inkTarget?.dispatchEvent(new Event('ink-cancel-touch'));
        phase = 'drain';
      }
      return;
    }
    const p = position(e);
    touches.set(e.pointerId, p);
    const likelyPalm =
      touch &&
      Math.max(e.width, e.height) >= 32 &&
      performance.now() - options.session.penFinishedAt < 350;
    if (settling || options.session.penActive || (likelyPalm && touches.size === 1))
      phase = 'drain';
    if (phase === 'drain' || phase === 'pinch') {
      capture(e.pointerId);
      consume(e);
      return;
    }
    if (touches.size === 1) {
      suppressClick = false;
      origin = p;
      if (mouseHand) {
        phase = 'pan';
        capture(e.pointerId);
        consume(e);
      } else if (
        !button &&
        !options.singleAction?.() &&
        writingTool(settings.tool) &&
        settings.fingerDrawing &&
        performance.now() - options.session.penFinishedAt >= 350
      ) {
        phase = 'ink';
        inkTarget = e.target;
      } else {
        phase = 'tap';
      }
      return;
    }
    if (phase === 'ink') inkTarget?.dispatchEvent(new Event('ink-cancel-touch'));
    window.getSelection()?.removeAllRanges();
    const [first, second] = touches.keys();
    pair = [first, second];
    const a = touches.get(first)!;
    const b = touches.get(second)!;
    const start = midpoint(a, b);
    span = Math.max(8, distance(a, b));
    gesture = { ...start, start, factor: 1 };
    phase = 'pinch';
    suppressClick = true;
    options.begin(start);
    capture(first);
    capture(second);
    consume(e);
  }
  function move(e: PointerEvent) {
    const old = touches.get(e.pointerId);
    if (!old) return;
    const p = position(e);
    touches.set(e.pointerId, p);
    if (phase === 'ink') return;
    if (phase === 'tap') {
      if (
        options.singleAction?.() ||
        distance(origin, p) < 6 ||
        !window.getSelection()?.isCollapsed
      )
        return;
      phase = 'pan';
      capture(e.pointerId);
      suppressClick = true;
      options.pan(origin.x - p.x, origin.y - p.y);
    } else if (phase === 'pan') {
      options.pan(old.x - p.x, old.y - p.y);
    } else if (phase === 'pinch' && pair.includes(e.pointerId)) {
      const a = touches.get(pair[0])!;
      const b = touches.get(pair[1])!;
      gesture = { ...midpoint(a, b), start: gesture.start, factor: distance(a, b) / span };
      if (!frame) frame = requestAnimationFrame(paint);
    }
    consume(e);
  }
  function up(e: PointerEvent) {
    if (e.type === 'lostpointercapture' && e.target !== node) {
      // The provisional layer can lose capture when the surface takes over.
      if (phase !== 'ink' && phase !== 'tap') return;
    }
    if (!touches.delete(e.pointerId)) return;
    const previous = phase;
    if (phase === 'pinch' && pair.includes(e.pointerId)) finish();
    if (!touches.size) {
      inkTarget = null;
      phase = settling ? 'drain' : 'idle';
    }
    if (previous === 'pan' || previous === 'pinch' || previous === 'drain') consume(e);
  }
  const captureOptions = { capture: true, passive: false, signal: listeners.signal };
  node.addEventListener('pointerdown', down, captureOptions);
  node.addEventListener('pointermove', move, captureOptions);
  node.addEventListener('pointerup', up, captureOptions);
  node.addEventListener('pointercancel', up, captureOptions);
  node.addEventListener('lostpointercapture', up, captureOptions);
  node.addEventListener(
    'click',
    (e) => {
      if (suppressClick && e.detail) {
        suppressClick = false;
        consume(e);
      }
    },
    captureOptions,
  );
  // A tap without capture can leave the surface over a toolbar or sidebar.
  window.addEventListener(
    'pointerup',
    (e) => {
      if (!node.contains(e.target as Node)) up(e);
    },
    captureOptions,
  );
  document.addEventListener('ink-finish', reset, { signal: listeners.signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) reset();
    },
    { signal: listeners.signal },
  );
  window.addEventListener('pagehide', reset, { signal: listeners.signal });
  window.addEventListener('blur', reset, { signal: listeners.signal });
  return {
    destroy() {
      listeners.abort();
      cancelAnimationFrame(frame);
    },
  };
}
