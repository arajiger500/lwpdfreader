<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { Annotation, Color, DocumentMeta, Progress, Rect } from '../lib/types';
  import { colors, newAnnotation } from '../lib/types';
  import { getAnnotations, saveAnnotation, deleteAnnotation, saveProgress } from '../lib/storage';
  import { getOutline, type OutlineEntry, type PDFDocumentProxy } from '../lib/pdf';
  import { exportBackup, downloadBackup } from '../lib/backup';
  import { ProgressWriter } from '../lib/progress';
  import Viewer from './Viewer.svelte';
  import Sidebar from './Sidebar.svelte';
  import Icon from './Icon.svelte';
  import InkToolbar from './InkToolbar.svelte';
  import { InkSession } from '../lib/ink-session';
  import { defaultInkSettings, validInkSettings, type InkSettings } from '../lib/ink-types';
  import { getSetting, setSetting } from '../lib/storage';
  let {
    doc,
    pdf,
    onBack,
    onError,
    theme,
    onTheme,
  }: {
    doc: DocumentMeta;
    pdf: PDFDocumentProxy;
    onBack: () => Promise<void>;
    onError: (e: unknown) => void;
    theme: string;
    onTheme: () => void;
  } = $props();
  const inkSession = untrack(() => new InkSession(doc.id, onError));
  const inkStatus = inkSession.status;
  let inkSettings = $state<InkSettings>(defaultInkSettings());
  let settingsTimer: ReturnType<typeof setTimeout>;
  let settingsTouched = false;
  function changeInk(settings: InkSettings) {
    document.dispatchEvent(new Event('ink-finish'));
    settingsTouched = true;
    region = false;
    selection = null;
    window.getSelection()?.removeAllRanges();
    inkSettings = settings;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => void setSetting('ink-settings', settings).catch(onError), 200);
  }
  let viewer: Viewer;
  let sidebarView = $state.raw<Sidebar | undefined>(undefined);
  let viewerReady = $state(false);
  let pageEditing = $state(false);
  let progress = $state<Progress>(untrack(() => ({ ...doc.progress })));
  let annotations = $state<Annotation[]>([]);
  let outline = $state<OutlineEntry[]>([]);
  let outlineLoading = $state(true);
  let sidebar = $state(false),
    focus = $state(false),
    region = $state(false),
    busy = $state(false);
  let selected = $state<Annotation | null>(null);
  let selection = $state<{ page: number; rects: Rect[]; text: string } | null>(null);
  let message = $state('');
  let pageInput = $state(String(untrack(() => doc.progress.page)));
  let saveState = $state('Saved on this device');
  let defaultColor = $state<Color>('yellow');
  let messageTimer: ReturnType<typeof setTimeout>;
  const writer = new ProgressWriter(
    async (p) => {
      await saveProgress(doc.id, p);
      if (
        ['page', 'offset', 'zoom', 'fit', 'mode', 'rotation'].every(
          (key) => p[key as keyof Progress] === progress[key as keyof Progress],
        )
      )
        saveState = 'Saved on this device';
    },
    (e) => {
      saveState = 'Position not saved';
      onError(e);
    },
  );
  const bookmarked = $derived(
    annotations.some((a) => a.kind === 'bookmark' && a.page === progress.page),
  );
  function report(p: Progress, immediate = false) {
    progress = p;
    if (!pageEditing) pageInput = String(p.page);
    saveState = 'Saving position…';
    writer.schedule(p);
    if (immediate) void writer.flush();
  }
  function tell(s: string) {
    message = s;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (message = ''), 6000);
  }
  async function persist(a: Annotation): Promise<boolean> {
    try {
      await saveAnnotation(a);
      const old = annotations.findIndex((x) => x.id === a.id);
      annotations = old < 0 ? [...annotations, a] : annotations.map((x) => (x.id === a.id ? a : x));
      if (selected?.id === a.id) selected = a;
      saveState = 'Saved on this device';
      return true;
    } catch (e) {
      onError(e);
      saveState = 'Annotation not saved';
      return false;
    }
  }
  async function remove(a: Annotation) {
    try {
      await deleteAnnotation(a.id);
      annotations = annotations.filter((x) => x.id !== a.id);
      if (selected?.id === a.id) selected = null;
    } catch (e) {
      onError(e);
    }
  }
  async function choose(a: Annotation | null) {
    if (selected?.id !== a?.id && sidebarView && !(await sidebarView.flushEditor())) return;
    selected = a;
    if (a) sidebar = true;
  }
  async function highlight(color: Color) {
    if (!selection || busy) return;
    busy = true;
    const s = selection;
    defaultColor = color;
    const a = newAnnotation(doc.id, s.page, 'highlight', { color, rects: s.rects, text: s.text });
    if (await persist(a)) {
      selection = null;
      window.getSelection()?.removeAllRanges();
      tell('Highlight saved');
    }
    busy = false;
  }
  async function addNote() {
    const a = newAnnotation(doc.id, progress.page, 'note');
    if (await persist(a)) {
      await choose(a);
      await tick();
      document.getElementById('annotation-note')?.focus();
    }
  }
  async function bookmark() {
    const existing = annotations.find((a) => a.kind === 'bookmark' && a.page === progress.page);
    if (existing) await remove(existing);
    else await persist(newAnnotation(doc.id, progress.page, 'bookmark'));
  }
  async function regionHighlight(page: number, rect: Rect) {
    if (
      await persist(
        newAnnotation(doc.id, page, 'highlight', {
          rects: [rect],
          color: defaultColor,
          text: 'Region highlight',
        }),
      )
    ) {
      region = false;
      tell('Region highlight saved');
    }
  }
  async function backup() {
    try {
      document.dispatchEvent(new Event('ink-finish'));
      if (!(await inkSession.flush())) {
        onError(new Error('Ink is not saved. Use Retry ink before leaving or exporting.'));
        return;
      }
      if (sidebarView && !(await sidebarView.flushEditor())) return;
      await writer.flush();
      downloadBackup(await exportBackup(doc.id), doc.name.replace(/\.pdf$/i, ''));
    } catch (e) {
      onError(e);
    }
  }
  async function back() {
    try {
      document.dispatchEvent(new Event('ink-finish'));
      if (!(await inkSession.flush())) {
        onError(new Error('Ink is not saved. Use Retry ink before leaving or exporting.'));
        return;
      }
      if (sidebarView && !(await sidebarView.flushEditor())) return;
      await writer.flush();
      await onBack();
    } catch (e) {
      onError(e);
    }
  }
  function jump() {
    if (!viewerReady) return;
    const n = Number(pageInput);
    if (!Number.isInteger(n) || n < 1 || n > pdf.numPages) {
      tell('Enter a page from 1 to ' + pdf.numPages);
      pageInput = String(progress.page);
      return;
    }
    void viewer.goTo(n);
    (document.activeElement as HTMLElement | null)?.blur();
  }
  function setting(p: Partial<Progress>) {
    void viewer.configure(p);
    selection = null;
  }
  function zoom(delta: number) {
    setting({ fit: 'custom', zoom: Math.max(0.25, Math.min(4, progress.zoom + delta)) });
  }
  async function undoInk() {
    document.dispatchEvent(new Event('ink-finish'));
    if (await inkSession.flush()) await inkSession.undo();
  }
  async function redoInk() {
    document.dispatchEvent(new Event('ink-finish'));
    if (await inkSession.flush()) await inkSession.redo();
  }
  function visibility(e: Event) {
    if (e.type === 'pagehide' || document.visibilityState === 'hidden') void writer.flush();
  }
  onMount(() => {
    let active = true;
    void getSetting<unknown>('ink-settings')
      .then((s) => {
        if (active && !settingsTouched) inkSettings = validInkSettings(s);
      })
      .catch(onError);
    const historyKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'z' &&
        !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)
      ) {
        e.preventDefault();
        void (e.shiftKey ? redoInk() : undoInk());
      }
    };
    window.addEventListener('keydown', historyKey);
    void getAnnotations(doc.id)
      .then((a) => {
        if (active) annotations = a;
      })
      .catch(onError);
    // Outline resolution is lazy so a large outline cannot delay the first page.
    const outlineTimer = setTimeout(() => {
      void getOutline(pdf)
        .then((o) => {
          if (active) outline = o;
        })
        .catch(() => tell('Could not read this PDF’s contents.'))
        .finally(() => {
          outlineLoading = false;
        });
    }, 500);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', visibility);
    return () => {
      active = false;
      window.removeEventListener('keydown', historyKey);
      clearTimeout(settingsTimer);
      if (settingsTouched) void setSetting('ink-settings', { ...inkSettings }).catch(onError);
      void inkSession.flush();
      clearTimeout(outlineTimer);
      clearTimeout(messageTimer);
      void writer.flush();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', visibility);
    };
  });
</script>

<div class="reader-shell" class:distraction-free={focus}>
  <header class="reader-header">
    <button class="icon-button" aria-label="Back to library" title="Library" onclick={back}
      ><Icon name="back" /></button
    >
    <div class="reader-title">
      <strong>{doc.name.replace(/\.pdf$/i, '')}</strong><span>{saveState}</span>
    </div>
    <div class="page-navigation">
      <button
        class="icon-button"
        aria-label="Previous page"
        disabled={!viewerReady || progress.page <= 1}
        onclick={() => viewer.goTo(progress.page - 1)}><Icon name="back" size={18} /></button
      >
      <form
        onsubmit={(e) => {
          e.preventDefault();
          jump();
        }}
      >
        <input
          aria-label="Page number"
          inputmode="numeric"
          bind:value={pageInput}
          disabled={!viewerReady}
          onfocus={() => (pageEditing = true)}
          onblur={() => {
            pageEditing = false;
            pageInput = String(progress.page);
          }}
        /><span>/ {pdf.numPages.toLocaleString()}</span>
      </form>
      <button
        class="icon-button"
        aria-label="Next page"
        disabled={!viewerReady || progress.page >= pdf.numPages}
        onclick={() => viewer.goTo(progress.page + 1)}><Icon name="next" size={18} /></button
      >
    </div>
    <span class="toolbar-divider"></span>
    <button
      class="icon-button"
      class:active={bookmarked}
      aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark page'}
      title="Bookmark page"
      onclick={bookmark}><Icon name="bookmark" /></button
    >
    <button
      class="icon-button"
      class:active={sidebar}
      aria-label="Toggle document sidebar"
      title="Contents, bookmarks & notes"
      onclick={async () => {
        if (sidebar && sidebarView && !(await sidebarView.flushEditor())) return;
        sidebar = !sidebar;
        if (!sidebar) selected = null;
      }}><Icon name="sidebar" /></button
    >
  </header>
  <div class="reader-tools">
    <div class="tool-group">
      <select
        aria-label="Reading mode"
        value={progress.mode}
        onchange={(e) => setting({ mode: e.currentTarget.value as Progress['mode'] })}
        ><option value="continuous">Continuous</option><option value="single">Single page</option
        ></select
      ><span class="toolbar-divider"></span><button
        class="icon-button"
        aria-label="Zoom out"
        onclick={() => zoom(-0.25)}><Icon name="minus" size={17} /></button
      ><select
        aria-label="Page fit"
        value={progress.fit}
        onchange={(e) => setting({ fit: e.currentTarget.value as Progress['fit'] })}
        ><option value="width">Fit width</option><option value="page">Fit page</option><option
          value="custom">{Math.round(progress.zoom * 100)}%</option
        ></select
      ><button class="icon-button" aria-label="Zoom in" onclick={() => zoom(0.25)}
        ><Icon name="plus" size={17} /></button
      >
    </div>
    <div class="tool-group">
      <button class="tool-button" onclick={addNote} aria-label="Add page note"
        ><Icon name="note" size={18} /><span>Page note</span></button
      ><button
        class="tool-button"
        class:active={region}
        onclick={() => {
          const next = !region;
          changeInk({ ...inkSettings, tool: 'text' });
          region = next;
          if (region)
            tell('Drag across a page to highlight a region. Turn this tool off to scroll.');
        }}
        aria-label="Region highlight"
        aria-pressed={region}><Icon name="region" size={18} /><span>Region</span></button
      ><button
        class="icon-button optional-tool"
        aria-label="Rotate clockwise"
        onclick={() => setting({ rotation: (progress.rotation + 90) % 360 })}
        ><Icon name="rotate" size={18} /></button
      ><button class="icon-button optional-tool" aria-label="Toggle theme" onclick={onTheme}
        ><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button
      ><button
        class="icon-button"
        aria-label="Focus reading"
        onclick={() => {
          changeInk({ ...inkSettings, tool: 'hand' });
          focus = true;
        }}><Icon name="focus" size={18} /></button
      >
    </div>
  </div>
  <main class="reader-main">
    <Viewer
      bind:this={viewer}
      {pdf}
      {inkSession}
      {inkSettings}
      initial={doc.progress}
      {annotations}
      regionMode={region}
      {focus}
      onProgress={report}
      onInitialized={() => (viewerReady = true)}
      onSelection={(s) => (selection = s)}
      onSelect={choose}
      onRegion={regionHighlight}
      {onError}
      onMessage={tell}
    />
    {#if sidebar}<Sidebar
        bind:this={sidebarView}
        {annotations}
        {outline}
        {outlineLoading}
        {selected}
        onSelect={choose}
        onSave={persist}
        onDelete={remove}
        onJump={(p) => viewer.goTo(p)}
        onClose={async () => {
          if (!(await sidebarView?.flushEditor())) return;
          sidebar = false;
          selected = null;
        }}
        onExport={backup}
      />{/if}
  </main>
  {#if !focus}
    <InkToolbar
      settings={inkSettings}
      status={$inkStatus}
      onChange={changeInk}
      onUndo={() => void undoInk()}
      onRedo={() => void redoInk()}
      onRetry={() => void inkSession.retry()}
    />
  {/if}
  {#if focus}<button class="exit-focus" onclick={() => (focus = false)}
      ><Icon name="focus" size={18} /> Show controls · {progress.page} / {pdf.numPages}</button
    >{/if}
  {#if selection}<div
      class="selection-toolbar"
      role="toolbar"
      tabindex="-1"
      aria-label="Highlight selected text"
      onpointerdown={(e) => e.preventDefault()}
    >
      <span><Icon name="highlight" size={18} /> Highlight</span>{#each colors as color}<button
          class={'swatch ' + color}
          disabled={busy}
          aria-label={'Highlight ' + color}
          onclick={() => highlight(color)}
        ></button>{/each}<button
        class="icon-button"
        aria-label="Dismiss selection"
        onclick={() => {
          selection = null;
          window.getSelection()?.removeAllRanges();
        }}><Icon name="close" size={17} /></button
      >
    </div>{/if}
  {#if message}<div class="toast" role="status">{message}</div>{/if}
</div>
