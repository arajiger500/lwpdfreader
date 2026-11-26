<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import InkLayer from './InkLayer.svelte';
  import InkToolbar from './InkToolbar.svelte';
  import { documentGestures, type Gesture } from '../lib/ink-touch';
  import { BoardStrokeIndex } from '../lib/board-viewport';
  import { InkSession } from '../lib/ink-session';
  import type { InkViewport } from '../lib/ink-geometry';
  import { writingTool, type InkSettings, type Stroke } from '../lib/ink-types';
  import {
    BOARD_SIZE,
    boardInkId,
    deleteBoard,
    unlinkBoard,
    updateBoard,
    type BoardAnchor,
    type BoardBackground,
    type Whiteboard,
  } from '../lib/whiteboard-storage';

  let {
    initial,
    anchor,
    preferences,
    onChange,
    onClose,
    onError,
  }: {
    initial: Whiteboard;
    anchor: BoardAnchor;
    preferences: InkSettings;
    onChange: (settings: InkSettings) => void;
    onClose: () => void;
    onError: (error: unknown) => void;
  } = $props();

  const session = untrack(() => new InkSession(boardInkId(initial.id), onError));
  const status = session.status;
  const box = [0, 0, BOARD_SIZE, BOARD_SIZE];
  let board = $state(untrack(() => ({ ...initial })));
  let title = $state(untrack(() => initial.title));
  let background = $state<BoardBackground>(untrack(() => initial.background));
  let metadataError = $state(false);
  let closing = $state(false);
  let dialog: HTMLDialogElement;
  let surface: HTMLDivElement;
  let content: HTMLDivElement;
  let width = $state(1),
    height = $state(1),
    zoom = $state(untrack(() => initial.view?.zoom ?? 1));
  let left = $state(BOARD_SIZE / 2),
    top = $state(BOARD_SIZE / 2);
  let firstSize = true;
  let origin: { x: number; y: number; left: number; top: number; zoom: number } | undefined;
  let indexed: Stroke[] | undefined;
  let index: BoardStrokeIndex;
  let tool = $state<InkSettings['tool']>(
    untrack(() => (writingTool(preferences.tool) ? preferences.tool : 'pen')),
  );
  let collapsed = $state(false);
  const settings = $derived({ ...preferences, tool, collapsed });
  const viewport = $derived.by<InkViewport>(() => {
    const x = left,
      y = top,
      scale = zoom;
    return {
      width,
      height,
      transform: [scale, 0, 0, -scale, -x * scale, (BOARD_SIZE - y) * scale],
      convertToPdfPoint: (px, py) => [x + px / scale, BOARD_SIZE - y - py / scale],
    };
  });
  function candidates(strokes: Stroke[], whole = false) {
    if (indexed !== strokes) {
      indexed = strokes;
      index = new BoardStrokeIndex(strokes);
    }
    const pad = 128 + settings.eraserSize;
    return index.query(
      {
        left: left - pad,
        top: top - pad,
        right: left + width / zoom + pad,
        bottom: top + height / zoom + pad,
      },
      whole,
    );
  }
  function moveTo(x: number, y: number) {
    left = Math.max(0, Math.min(BOARD_SIZE - width / zoom, x));
    top = Math.max(0, Math.min(BOARD_SIZE - height / zoom, y));
  }
  const clamp = (scale: number) => Math.min(4, Math.max(0.25, scale));
  function begin(point: { x: number; y: number }) {
    const bounds = surface.getBoundingClientRect();
    origin = { x: point.x - bounds.left, y: point.y - bounds.top, left, top, zoom };
  }
  function preview(g: Gesture) {
    if (!origin) return;
    const factor = clamp(origin.zoom * g.factor) / origin.zoom;
    const x = g.x - g.start.x + origin.x * (1 - factor);
    const y = g.y - g.start.y + origin.y * (1 - factor);
    content.style.transform = `matrix(${factor},0,0,${factor},${x},${y})`;
  }
  async function end(g: Gesture) {
    const start = origin;
    if (!start) return;
    origin = undefined;
    zoom = clamp(start.zoom * g.factor);
    moveTo(
      start.left + start.x / start.zoom - (start.x + g.x - g.start.x) / zoom,
      start.top + start.y / start.zoom - (start.y + g.y - g.start.y) / zoom,
    );
    await tick();
    if (content) content.style.transform = '';
  }
  function zoomBy(factor: number) {
    const bounds = surface.getBoundingClientRect();
    const center = { x: bounds.left + width / 2, y: bounds.top + height / 2 };
    begin(center);
    void end({ ...center, start: center, factor });
  }
  async function persist() {
    const nextTitle = title,
      nextBackground = background;
    const view = {
      x: Math.min(1, (left + width / (2 * zoom)) / BOARD_SIZE),
      y: Math.min(1, (top + height / (2 * zoom)) / BOARD_SIZE),
      zoom,
    };
    const previous = board.view ?? { x: 0.5, y: 0.5, zoom: 1 };
    if (
      nextTitle === board.title &&
      nextBackground === board.background &&
      previous.x === view.x &&
      previous.y === view.y &&
      previous.zoom === view.zoom
    ) {
      metadataError = false;
      return true;
    }
    try {
      board = await updateBoard(board.id, { title: nextTitle, background: nextBackground, view });
      if (title === nextTitle) title = board.title;
      metadataError = false;
      return true;
    } catch (error) {
      metadataError = true;
      onError(error);
      return false;
    }
  }
  let metadataWrite = Promise.resolve(true);
  function saveMetadata() {
    return (metadataWrite = metadataWrite.then(persist));
  }
  async function safely(operation: () => void | Promise<void>, save = true) {
    if (closing) return;
    closing = true;
    document.dispatchEvent(new Event('ink-finish'));
    try {
      if ((await session.flush()) && (!save || (await saveMetadata()))) await operation();
    } catch (error) {
      onError(error);
    } finally {
      closing = false;
    }
  }
  function history(redo: boolean) {
    document.dispatchEvent(new Event('ink-finish'));
    void (redo ? session.redo() : session.undo());
  }
  function historyKey(event: KeyboardEvent) {
    if (
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== 'z' ||
      (event.target as Element).closest('input, textarea')
    )
      return;
    event.preventDefault();
    history(event.shiftKey);
  }
  onMount(() => {
    dialog.showModal();
    const resize = new ResizeObserver(([entry]) => {
      const x = firstSize ? BOARD_SIZE * (initial.view?.x ?? 0.5) : left + width / (2 * zoom);
      const y = firstSize ? BOARD_SIZE * (initial.view?.y ?? 0.5) : top + height / (2 * zoom);
      firstSize = false;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      moveTo(x - width / (2 * zoom), y - height / (2 * zoom));
    });
    resize.observe(surface);
    const visibility = () => {
      if (document.hidden) {
        void saveMetadata();
        void session.flush();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      resize.disconnect();
      document.removeEventListener('visibilitychange', visibility);
    };
  });
</script>

<dialog
  class="whiteboard"
  bind:this={dialog}
  aria-label="Whiteboard"
  onkeydown={historyKey}
  oncancel={(e) => {
    e.preventDefault();
    void safely(onClose);
  }}
>
  <header class="board-header">
    <button onclick={() => safely(onClose)} disabled={closing}>Back to PDF</button>
    <input
      aria-label="Whiteboard title"
      bind:value={title}
      maxlength="120"
      onchange={saveMetadata}
    />
    <select aria-label="Whiteboard background" bind:value={background} onchange={saveMetadata}>
      <option value="blank">Blank</option>
      <option value="grid">Grid</option>
      <option value="dotted">Dotted</option>
    </select>
    <button aria-label="Zoom out whiteboard" onclick={() => zoomBy(0.8)}>−</button>
    <button aria-label="Zoom in whiteboard" onclick={() => zoomBy(1.25)}>+</button>
    <details>
      <summary>Actions</summary>
      <div>
        <button
          onclick={() => {
            if (window.confirm('Clear all handwriting on this whiteboard?'))
              void safely(async () => {
                await session.clearPage(1);
              });
          }}>Clear whiteboard</button
        >
        <button
          onclick={() =>
            safely(async () => {
              await unlinkBoard(anchor.id);
              onClose();
            })}>Unlink from this point</button
        >
        <button
          onclick={() => {
            if (window.confirm('Permanently delete this whiteboard and all its links?')) {
              void safely(async () => {
                await deleteBoard(board.id);
                onClose();
              }, false);
            }
          }}>Delete whiteboard</button
        >
      </div>
    </details>
  </header>
  {#if metadataError}<button class="board-error" onclick={saveMetadata}
      >Whiteboard settings not saved · Retry</button
    >{/if}
  <div
    class="board-surface"
    bind:this={surface}
    inert={closing}
    use:documentGestures={{
      settings: () => settings,
      session,
      onError,
      pan: (dx, dy) => moveTo(left + dx / zoom, top + dy / zoom),
      begin,
      preview,
      end,
    }}
  >
    <div
      class="board-content"
      class:grid={background === 'grid'}
      class:dotted={background === 'dotted'}
      style:background-size={24 * zoom + 'px ' + 24 * zoom + 'px'}
      style:background-position={((-left * zoom) % (24 * zoom)) +
        'px ' +
        ((-top * zoom) % (24 * zoom)) +
        'px'}
      bind:this={content}
    >
      <InkLayer
        {session}
        page={1}
        {viewport}
        {box}
        {settings}
        {onError}
        visibleStrokes={(strokes) => candidates(strokes)}
        eraserStrokes={candidates}
      />
    </div>
  </div>
  <InkToolbar
    {settings}
    status={$status}
    whiteboard
    onChange={(next) => {
      tool = next.tool;
      collapsed = next.collapsed;
      onChange({ ...next, tool: preferences.tool, collapsed: preferences.collapsed });
    }}
    onUndo={() => history(false)}
    onRedo={() => history(true)}
    onRetry={() => void session.retry()}
  />
</dialog>
