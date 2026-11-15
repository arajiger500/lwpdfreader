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
  let saving: Promise<boolean> | undefined;
  let deleting = false;
  export function flush(): Promise<boolean> {
    clearTimeout(timer);
    if (saving) return saving;
    if (!dirty || deleting) return Promise.resolve(true);
    saving = drain().finally(() => {
      saving = undefined;
    });
    return saving;
  }
  async function drain(): Promise<boolean> {
    while (dirty && !deleting) {
      dirty = false;
      status = 'Saving…';
      const ok = await onSave({ ...annotation, note, updatedAt: Date.now() });
      if (!ok) {
        dirty = !deleting;
        status = 'Not saved — retry';
        return false;
      }
    }
    status = 'Saved';
    return true;
  }
  const save = () => flush();
  function change() {
    deleting = false;
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
    if (dirty && !deleting) void save();
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
      onclick={async () => {
        if (await flush()) onClose();
      }}><Icon name="close" size={17} /></button
    >
  </div>
  {#if annotation.text}<blockquote>{annotation.text}</blockquote>{/if}
  {#if annotation.kind === 'highlight'}<div class="color-options" aria-label="Highlight colors">
      {#each colors as color}<button
          class={'swatch ' + color}
          class:chosen={annotation.color === color}
          aria-label={'Change highlight to ' + color}
          onclick={async () => {
            if (await flush()) await onSave({ ...annotation, color, note, updatedAt: Date.now() });
          }}
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
      onclick={async () => {
        deleting = true;
        clearTimeout(timer);
        await saving;
        dirty = false;
        onDelete(annotation);
      }}><Icon name="trash" size={16} /> Delete</button
    ><button class="save-status" onclick={() => void save()} aria-label="Retry saving note"
      >{status}</button
    >
  </div>
</section>
