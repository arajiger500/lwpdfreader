<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { Annotation } from '../lib/types';
  import { colors } from '../lib/types';
  import Icon from './Icon.svelte';
  let {
    annotation,
    onSave,
    onDelete,
    onClose,
  }: {
    annotation: Annotation;
    onSave: (a: Annotation) => Promise<boolean>;
    onDelete: (a: Annotation) => void;
    onClose: () => void;
  } = $props();
  let note = $state(untrack(() => annotation.note));
  let status = $state('Saved');
  let timer: ReturnType<typeof setTimeout>;
  let dirty = false;
  async function save() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    status = 'Saving…';
    const ok = await onSave({ ...annotation, note, updatedAt: Date.now() });
    status = ok ? 'Saved' : 'Not saved — retry';
    if (!ok) dirty = true;
  }
  function change() {
    dirty = true;
    status = 'Unsaved';
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 450);
  }
  onMount(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void save();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', save);
    };
  });
  onDestroy(() => {
    clearTimeout(timer);
    if (dirty) void save();
  });
</script>

<section class="annotation-editor" aria-label="Edit annotation">
  <div class="section-heading">
    <strong
      >{annotation.kind === 'highlight'
        ? 'Highlight'
        : annotation.kind === 'bookmark'
          ? 'Bookmark'
          : 'Page note'} · {annotation.page}</strong
    ><button
      class="icon-button"
      aria-label="Close annotation editor"
      onclick={() => {
        void save();
        onClose();
      }}><Icon name="close" size={17} /></button
    >
  </div>
  {#if annotation.text}<blockquote>{annotation.text}</blockquote>{/if}
  {#if annotation.kind === 'highlight'}<div class="color-options" aria-label="Highlight colors">
      {#each colors as color}<button
          class={'swatch ' + color}
          class:chosen={annotation.color === color}
          aria-label={'Change highlight to ' + color}
          onclick={() => onSave({ ...annotation, color, note, updatedAt: Date.now() })}
        ></button>{/each}
    </div>{/if}
  <label class="field-label" for="annotation-note"
    >{annotation.kind === 'bookmark' ? 'Bookmark label' : 'Your note'}</label
  >
  <textarea
    id="annotation-note"
    bind:value={note}
    oninput={change}
    onblur={() => void save()}
    placeholder="Capture a thought…"
    maxlength="100000"
    rows="5"
  ></textarea>
  <div class="editor-footer">
    <button
      class="text-button danger"
      onclick={() => {
        dirty = false;
        clearTimeout(timer);
        onDelete(annotation);
      }}><Icon name="trash" size={16} /> Delete</button
    ><button class="save-status" onclick={() => void save()} aria-label="Retry saving note"
      >{status}</button
    >
  </div>
</section>
