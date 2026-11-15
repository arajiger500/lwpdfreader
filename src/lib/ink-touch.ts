import type { InkSession } from './ink-session';
import type { InkSettings } from './ink-types';
import { writingTool } from './ink-types';
/** Drawing-mode fingers pan in JS because touch-action cannot differ by pointer
 * type. Hand/text modes retain native browser pan/pinch. Capture stays on the
 * scroll container, so virtual page disposal cannot interrupt a finger pan. */
export function inkTouchPan(
  node: HTMLElement,
  options: { settings: () => InkSettings; session: InkSession },
) {
  const touches = new Map<number, { x: number; y: number }>();
  let vx = 0,
    vy = 0,
    lastTime = 0,
    frame = 0;
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    vx = vy = 0;
  }
  function down(e: PointerEvent) {
    const settings = options.settings();
    const mouseHand = settings.tool === 'hand' && e.pointerType === 'mouse' && e.button === 0;
    if (
      !mouseHand &&
      (!writingTool(settings.tool) || e.pointerType !== 'touch' || settings.fingerDrawing)
    )
      return;
    stop();
    e.preventDefault();
    e.stopImmediatePropagation();
    if (options.session.penActive || performance.now() - options.session.penFinishedAt < 450)
      return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastTime = performance.now();
    node.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    const old = touches.get(e.pointerId);
    if (!old) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (options.session.penActive) {
      touches.delete(e.pointerId);
      return;
    }
    const dx = old.x - e.clientX,
      dy = old.y - e.clientY,
      now = performance.now(),
      dt = Math.max(8, now - lastTime);
    node.scrollLeft += dx / touches.size;
    node.scrollTop += dy / touches.size;
    vx = Math.max(-4, Math.min(4, dx / dt));
    vy = Math.max(-4, Math.min(4, dy / dt));
    lastTime = now;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  function inertia() {
    if (options.session.penActive) {
      stop();
      return;
    }
    vx *= 0.92;
    vy *= 0.92;
    node.scrollLeft += vx * 16;
    node.scrollTop += vy * 16;
    if (Math.hypot(vx, vy) > 0.025) frame = requestAnimationFrame(inertia);
  }
  function up(e: PointerEvent) {
    if (!touches.delete(e.pointerId)) return;
    e.stopImmediatePropagation();
    if (
      !touches.size &&
      e.pointerType === 'touch' &&
      e.type === 'pointerup' &&
      performance.now() - lastTime < 80
    )
      frame = requestAnimationFrame(inertia);
  }
  document.addEventListener('ink-finish', stop);
  node.addEventListener('pointerdown', down, { capture: true, passive: false });
  node.addEventListener('pointermove', move, { capture: true, passive: false });
  node.addEventListener('pointerup', up, true);
  node.addEventListener('pointercancel', up, true);
  node.addEventListener('lostpointercapture', up, true);
  return {
    destroy() {
      stop();
      document.removeEventListener('ink-finish', stop);
      node.removeEventListener('pointerdown', down, true);
      node.removeEventListener('pointermove', move, true);
      node.removeEventListener('pointerup', up, true);
      node.removeEventListener('pointercancel', up, true);
      node.removeEventListener('lostpointercapture', up, true);
    },
  };
}
