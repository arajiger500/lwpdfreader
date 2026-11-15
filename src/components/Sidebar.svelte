<script lang="ts">
  import type { Annotation } from '../lib/types';
  import type { OutlineEntry } from '../lib/pdf';
  import Icon from './Icon.svelte';
  import AnnotationEditor from './AnnotationEditor.svelte';
  let {
    annotations,
    outline,
    outlineLoading,
    selected,
    onSelect,
    onSave,
    onDelete,
    onJump,
    onClose,
    onExport,
  }: {
    annotations: Annotation[];
    outline: OutlineEntry[];
    outlineLoading: boolean;
    selected: Annotation | null;
    onSelect: (a: Annotation | null) => void;
    onSave: (a: Annotation) => Promise<boolean>;
    onDelete: (a: Annotation) => void;
    onJump: (p: number) => void;
    onClose: () => void;
    onExport: () => void;
  } = $props();
  let tab = $state<'annotations' | 'contents' | 'bookmarks'>('annotations');
  let query = $state('');
  let limit = $state(200);
  const filtered = $derived(
    annotations
      .filter(
        (a) =>
          (tab === 'bookmarks' ? a.kind === 'bookmark' : a.kind !== 'bookmark') &&
          `${a.text} ${a.note}`.toLowerCase().includes(query.toLowerCase()),
      )
      .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt),
  );
</script>

<aside class="sidebar" aria-label="Document sidebar">
  <div class="sidebar-header">
    <h2>In this document</h2>
    <button class="icon-button" aria-label="Close sidebar" onclick={onClose}
      ><Icon name="close" /></button
    >
  </div>
  <div class="tabs" role="tablist" aria-label="Sidebar sections">
    {#each ['annotations', 'contents', 'bookmarks'] as name}<button
        role="tab"
        aria-selected={tab === name}
        class:active={tab === name}
        onclick={() => (tab = name as typeof tab)}
        >{name === 'annotations' ? 'Notes' : name === 'contents' ? 'Contents' : 'Bookmarks'}</button
      >{/each}
  </div>
  <div class="sidebar-body">
    {#if selected}{#key selected.id}<AnnotationEditor
          annotation={selected}
          {onSave}
          {onDelete}
          onClose={() => onSelect(null)}
        />{/key}{/if}
    {#if tab === 'contents'}
      {#if outlineLoading}<p class="muted sidebar-empty">
          Loading contents…
        </p>{:else if !outline.length}<p class="muted sidebar-empty">
          This PDF has no table of contents.
        </p>{/if}
      {#each outline as item}<button
          class="outline-item"
          style:padding-left={16 + Math.min(item.depth, 5) * 12 + 'px'}
          onclick={() => onJump(item.page)}
          ><span>{item.title}</span><small>{item.page}</small></button
        >{/each}
    {:else}
      <div class="sidebar-search">
        <Icon name="search" size={16} /><input
          aria-label="Search annotations"
          placeholder="Find in your notes"
          bind:value={query}
        />
      </div>
      {#if !filtered.length}<div class="sidebar-empty">
          <Icon name={tab === 'bookmarks' ? 'bookmark' : 'highlight'} size={28} />
          <p>{tab === 'bookmarks' ? 'Keep a page close.' : 'Make the page your own.'}</p>
          <small
            >{tab === 'bookmarks'
              ? 'Tap the bookmark button to save a page.'
              : 'Select text to highlight it, or add a page note.'}</small
          >
        </div>{/if}
      {#each filtered.slice(0, limit) as a (a.id)}<button
          class="annotation-item"
          class:active={selected?.id === a.id}
          onclick={() => {
            onSelect(a);
            onJump(a.page);
          }}
          ><span class="annotation-meta"
            ><span class={'annotation-dot ' + a.color}></span>{a.kind === 'bookmark'
              ? 'Bookmark'
              : a.kind === 'note'
                ? 'Note'
                : 'Highlight'}<span>Page {a.page}</span></span
          >{#if a.text}<span class="annotation-quote">{a.text}</span>{/if}{#if a.note}<span
              class="annotation-note">{a.note}</span
            >{/if}</button
        >{/each}
      {#if filtered.length > limit}<button class="load-more" onclick={() => (limit += 200)}
          >Show more ({filtered.length - limit} remaining)</button
        >{/if}
    {/if}
  </div>
  <button class="sidebar-export" onclick={onExport}
    ><Icon name="export" size={17} /> Export document backup</button
  >
</aside>
