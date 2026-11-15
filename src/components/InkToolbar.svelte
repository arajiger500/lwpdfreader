<script lang="ts">
  import Icon from './Icon.svelte';
  import { writingTool, type InkSettings, type InkTool } from '../lib/ink-types';
  import type { InkStatus } from '../lib/ink-session';
  let {
    settings,
    status,
    onChange,
    onUndo,
    onRedo,
    onRetry,
  }: {
    settings: InkSettings;
    status: InkStatus;
    onChange: (s: InkSettings) => void;
    onUndo: () => void;
    onRedo: () => void;
    onRetry: () => void;
  } = $props();
  let options = $state(false);
  const tools: { id: InkTool; name: string; icon: string }[] = [
    { id: 'hand', name: 'Hand tool', icon: 'hand' },
    { id: 'text', name: 'Text highlight tool', icon: 'highlight' },
    { id: 'pen', name: 'Pen tool', icon: 'pen' },
    { id: 'marker', name: 'Freehand highlighter tool', icon: 'marker' },
    { id: 'eraser', name: 'Eraser tool', icon: 'eraser' },
  ];
  const palette = $derived(
    settings.tool === 'marker'
      ? ['#f5d742', '#88cd91', '#ef9fbb', '#83bde5', '#f3a454']
      : ['#222222', '#2856b6', '#c3463f', '#31774c'],
  );
  const color = $derived(settings.tool === 'marker' ? settings.markerColor : settings.penColor);
  function patch(change: Partial<InkSettings>) {
    onChange({ ...settings, ...change });
  }
  function setColor(c: string) {
    patch(settings.tool === 'marker' ? { markerColor: c } : { penColor: c });
  }
</script>

{#if settings.collapsed}<button
    class="ink-expand"
    aria-label="Show annotation tools"
    onclick={() => patch({ collapsed: false })}
    ><Icon name="pen" size={19} /><span>Annotate</span></button
  >
{:else}
  <div class="ink-toolbar-wrap">
    {#if options}<section class="ink-options" aria-label="Annotation tool settings">
        {#if settings.tool === 'eraser'}
          <label
            >Eraser mode<select
              aria-label="Eraser mode"
              value={settings.eraserMode}
              onchange={(e) =>
                patch({ eraserMode: e.currentTarget.value as InkSettings['eraserMode'] })}
              ><option value="precision">Precision · split strokes</option><option value="stroke"
                >Whole stroke</option
              ></select
            ></label
          >
          <label
            >Erase<select
              aria-label="Erase target"
              value={settings.eraserTarget}
              onchange={(e) =>
                patch({ eraserTarget: e.currentTarget.value as InkSettings['eraserTarget'] })}
              ><option value="both">Pen & marker</option><option value="pen">Pen only</option
              ><option value="marker">Marker only</option></select
            ></label
          >
          <label
            >Eraser size · {settings.eraserSize} pt<input
              aria-label="Eraser size"
              type="range"
              min="2"
              max="100"
              step="2"
              value={settings.eraserSize}
              oninput={(e) => patch({ eraserSize: Number(e.currentTarget.value) })}
            /></label
          >
        {:else if settings.tool === 'pen' || settings.tool === 'marker'}
          <div class="ink-palette">
            {#each palette as c}<button
                aria-label={'Ink color ' + c}
                class:chosen={color === c}
                style:--ink-color={c}
                onclick={() => setColor(c)}
              ></button>{/each}<label class="custom-ink-color" title="Custom ink color"
              ><input
                type="color"
                aria-label="Custom ink color"
                value={color}
                oninput={(e) => setColor(e.currentTarget.value)}
              /></label
            >
          </div>
          <label
            >Stroke width · {settings.tool === 'marker' ? settings.markerWidth : settings.penWidth} pt<input
              aria-label="Stroke width"
              type="range"
              min={settings.tool === 'marker' ? 2 : 0.5}
              max={settings.tool === 'marker' ? 80 : 40}
              step={settings.tool === 'marker' ? 1 : 0.1}
              value={settings.tool === 'marker' ? settings.markerWidth : settings.penWidth}
              oninput={(e) =>
                patch(
                  settings.tool === 'marker'
                    ? { markerWidth: Number(e.currentTarget.value) }
                    : { penWidth: Number(e.currentTarget.value) },
                )}
            /></label
          >
          <label class="ink-check"
            ><input
              type="checkbox"
              checked={settings.smoothing}
              onchange={(e) => patch({ smoothing: e.currentTarget.checked })}
            /> Smooth input</label
          >
        {/if}
        <label class="ink-check"
          ><input
            type="checkbox"
            checked={settings.fingerDrawing}
            onchange={(e) => patch({ fingerDrawing: e.currentTarget.checked })}
          /> Draw with a finger</label
        >
        <p>
          {settings.fingerDrawing
            ? 'Finger input draws; use Hand to scroll.'
            : 'Pencil draws; fingers pan. Use Hand for native pinch zoom.'}
        </p>
      </section>{/if}
    <div class="ink-toolbar" role="toolbar" aria-label="Annotation tools" tabindex="-1">
      {#each tools as tool}<button
          class:active={settings.tool === tool.id}
          aria-label={tool.name}
          aria-pressed={settings.tool === tool.id}
          title={tool.name}
          onclick={() => {
            patch({ tool: tool.id });
            options = false;
          }}><Icon name={tool.icon} size={21} /></button
        >{/each}
      <span class="toolbar-divider"></span>
      <button
        aria-label="Tool options"
        aria-expanded={options}
        class:active={options}
        onclick={() => (options = !options)}
        >{#if settings.tool === 'pen' || settings.tool === 'marker'}<span
            class="current-ink-color"
            style:background={color}
          ></span>{:else}<Icon name="settings" size={19} />{/if}</button
      >
      <button aria-label="Undo ink" disabled={!status.canUndo} onclick={onUndo}
        ><Icon name="undo" size={20} /></button
      ><button aria-label="Redo ink" disabled={!status.canRedo} onclick={onRedo}
        ><Icon name="redo" size={20} /></button
      >
      <button
        aria-label="Collapse annotation tools"
        onclick={() => {
          patch({ collapsed: true, tool: 'hand' });
          options = false;
        }}><Icon name="collapse" size={18} /></button
      >
    </div>
    {#if status.failed}<button class="ink-save-indicator failed" onclick={onRetry}
        >{status.pending ? 'Ink not saved · Retry ink' : 'Ink unavailable · Retry ink'}</button
      >{:else if status.pending}<span class="ink-save-indicator" role="status"
        >Saving {status.pending} ink {status.pending === 1 ? 'action' : 'actions'}…</span
      >{:else if writingTool(settings.tool)}<span class="ink-save-indicator"
        >{settings.fingerDrawing ? 'Finger drawing on' : 'Pencil / mouse · Fingers scroll'}</span
      >{/if}
  </div>
{/if}
