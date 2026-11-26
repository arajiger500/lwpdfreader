<script lang="ts">
  import Icon from './Icon.svelte';
  import type { DocumentMeta } from '../lib/types';
  let {
    documents,
    busy,
    status,
    usage,
    theme,
    onImport,
    onOpen,
    onDelete,
    onExport,
    onRestore,
    onTheme,
    onPersist,
  }: {
    documents: DocumentMeta[];
    busy: boolean;
    status: string;
    usage: string;
    theme: string;
    onImport: (f: File) => void;
    onOpen: (d: DocumentMeta) => void;
    onDelete: (d: DocumentMeta) => void;
    onExport: () => void;
    onRestore: (f: File) => void;
    onTheme: () => void;
    onPersist: () => void;
  } = $props();
  let picker: HTMLInputElement, restore: HTMLInputElement;
  let query = $state('');
  let drag = $state(false);
  const filtered = $derived(
    documents.filter((d) => d.name.toLowerCase().includes(query.toLowerCase())),
  );
  const bytes = (n: number) =>
    n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
</script>

<div class="library-shell">
  <header class="library-header">
    <a class="brand" href="/" onclick={(e) => e.preventDefault()} aria-label="LWPDFReader library"
      ><span class="brand-mark"><Icon name="book" size={23} /></span><span
        >LWPDF<span class="brand-light">Reader</span></span
      ></a
    >
    <div class="header-actions">
      <span class="offline-label"><span></span> Local & private</span><button
        class="icon-button"
        aria-label="Toggle theme"
        onclick={onTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button
      >
    </div>
  </header>
  <main class="library-main">
    <div class="library-intro">
      <div>
        <p class="eyebrow">YOUR READING SPACE</p>
        <h1>
          Library<span class="document-count">{documents.length.toString().padStart(2, '0')}</span>
        </h1>
        <p class="muted">A quiet place for big ideas.</p>
      </div>
      <button class="primary-button" disabled={busy} onclick={() => picker.click()}
        ><Icon name="plus" size={19} /> Import PDF</button
      >
    </div>
    <input
      class="visually-hidden"
      type="file"
      disabled={busy}
      accept="application/pdf,.pdf"
      bind:this={picker}
      aria-label="Import PDF file"
      onchange={(e) => {
        const f = e.currentTarget.files?.[0];
        if (f) onImport(f);
        e.currentTarget.value = '';
      }}
    />
    <input
      class="visually-hidden"
      type="file"
      disabled={busy}
      accept="application/json,.json"
      bind:this={restore}
      aria-label="Import annotation backup"
      onchange={(e) => {
        const f = e.currentTarget.files?.[0];
        if (f) onRestore(f);
        e.currentTarget.value = '';
      }}
    />
    {#if busy}<div class="import-progress" role="status">
        <span class="spinner"></span>{status}
      </div>{/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      class="library-content"
      class:dragging={drag}
      ondragover={(e) => {
        e.preventDefault();
        drag = true;
      }}
      ondragleave={() => (drag = false)}
      ondrop={(e) => {
        e.preventDefault();
        drag = false;
        const f = e.dataTransfer?.files[0];
        if (f && !busy) onImport(f);
      }}
      aria-label="PDF library"
    >
      {#if documents.length}
        <div class="library-list-tools">
          <span>RECENTLY OPENED</span><label class="search"
            ><Icon name="search" size={17} /><input
              aria-label="Search library"
              bind:value={query}
              placeholder="Find a document"
            /></label
          >
        </div>
        <div class="document-table-heading">
          <span>DOCUMENT</span><span>READING PROGRESS</span><span>SIZE</span><span></span>
        </div>
        {#each filtered as doc (doc.id)}{@const percent = Math.round(
            (doc.progress.page / doc.pageCount) * 100,
          )}
          <div class="document-row">
            <button
              class="document-open"
              disabled={busy || !doc.available}
              onclick={() => onOpen(doc)}
              ><span class="pdf-cover"><Icon name="file" size={27} /><small>PDF</small></span><span
                class="document-name"
                ><strong>{doc.name.replace(/\.pdf$/i, '')}</strong><small
                  >{doc.pageCount.toLocaleString()} pages{!doc.available
                    ? ' · Import the original PDF to reconnect'
                    : ''}</small
                ></span
              ></button
            >
            <div class="reading-progress">
              <span
                >Page {doc.progress.page} <small>of {doc.pageCount.toLocaleString()}</small></span
              >
              <div class="progress-track"><i style:width={percent + '%'}></i></div>
            </div>
            <span class="document-size">{bytes(doc.size)}</span><button
              class="icon-button delete-document"
              aria-label={'Remove ' + doc.name}
              onclick={() => onDelete(doc)}
              disabled={busy}><Icon name="trash" size={18} /></button
            >
          </div>
        {/each}
        {#if !filtered.length}<p class="empty-search">No documents match “{query}”.</p>{/if}
      {:else}
        <div class="empty-library">
          <div class="empty-book"><Icon name="book" size={50} /></div>
          <p class="eyebrow">LESS FRICTION. MORE FOCUS.</p>
          <h2>Your next chapter starts here.</h2>
          <p>
            Bring your textbooks, papers, and everything<br class="desktop-break" /> worth a closer read.
            Pick up exactly where you left off.
          </p>
          <button class="secondary-button" disabled={busy} onclick={() => picker.click()}
            ><Icon name="import" size={18} /> Choose your first PDF</button
          ><small>Or drop a PDF here · Your files stay on this device</small>
        </div>
      {/if}
    </section>
    <div class="library-bottom">
      <div class="privacy-note">
        <Icon name="shield" size={20} />
        <div>
          <strong>Made for your device. Kept on your device.</strong>
          <p>No account. No uploads. Read and annotate offline.</p>
        </div>
      </div>
      <div class="backup-actions">
        <button class="text-button" disabled={busy || !documents.length} onclick={onExport}
          ><Icon name="export" size={17} /> Export backup</button
        ><button class="text-button" disabled={busy} onclick={() => restore.click()}
          ><Icon name="import" size={17} /> Restore backup</button
        >
      </div>
    </div>
    <div class="storage-note">
      <span
        >{usage} Browser storage can be cleared by iPadOS. Export regular annotation backups; keep your
        original PDFs.</span
      ><button class="text-button" onclick={onPersist}>Protect local storage</button>
    </div>
  </main>
  <footer class="library-footer">
    <span>LWPDFReader</span><span>Room to read. Space to think.</span><span>1.0</span>
  </footer>
</div>
