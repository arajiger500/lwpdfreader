<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Library from './components/Library.svelte';
  import Icon from './components/Icon.svelte';
  import { initCore } from './lib/core';
  import {
    listDocuments,
    getFile,
    importDocument,
    getSetting,
    setSetting,
    removeDocument,
  } from './lib/storage';
  import { fingerprint, loadPdf, type PDFDocumentProxy } from './lib/pdf';
  import { defaultProgress, errorMessage, type DocumentMeta } from './lib/types';
  import { exportBackup, importBackup, downloadBackup } from './lib/backup';
  import { registerSW } from 'virtual:pwa-register';
  let documents = $state<DocumentMeta[]>([]),
    active = $state<DocumentMeta | null>(null),
    pdf = $state.raw<PDFDocumentProxy | null>(null);
  let busy = $state(true),
    status = $state('Opening your library…'),
    error = $state(''),
    notice = $state(''),
    usage = $state('');
  let theme = $state('light'),
    ready = $state(false),
    updateAvailable = $state(false),
    offlineReady = $state(false);
  let removeTarget = $state<DocumentMeta | null>(null);
  let updateSW: (reload?: boolean) => Promise<void>;
  let Reader = $state<typeof import('./components/Reader.svelte').default>();
  async function prepareReader() {
    const [module] = await Promise.all([import('./components/Reader.svelte'), initCore()]);
    Reader = module.default;
  }
  const showError = (e: unknown) => (error = errorMessage(e));
  async function refresh() {
    documents = await listDocuments();
    await estimate();
  }
  async function estimate() {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      usage = e.usage ? `${(e.usage / 1024 / 1024).toFixed(1)} MB used locally. ` : '';
    }
  }
  async function protect() {
    try {
      const allowed = await navigator.storage?.persist?.();
      notice = allowed
        ? 'Persistent storage granted. Keep exporting backups as an extra safeguard.'
        : 'Your browser manages storage automatically. Keep regular annotation backups and the original PDFs.';
      await estimate();
    } catch (e) {
      showError(e);
    }
  }
  async function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    try {
      await setSetting('theme', theme);
    } catch (e) {
      showError(e);
    }
  }
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });
  async function open(doc: DocumentMeta) {
    if (busy) return;
    busy = true;
    status = 'Opening ' + doc.name + '…';
    try {
      const [file] = await Promise.all([getFile(doc.id), prepareReader()]);
      if (!file)
        throw new Error('The original PDF is missing. Import it again to reconnect your notes.');
      const loaded = await loadPdf(file);
      pdf = loaded;
      active = doc;
      await setSetting('lastDocument', doc.id);
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
    }
  }
  async function back() {
    busy = true;
    status = 'Closing document…';
    try {
      active = null;
      const old = pdf;
      pdf = null;
      await tick();
      if (old) await old.loadingTask.destroy();
      await setSetting('lastDocument', null);
      await refresh();
    } finally {
      busy = false;
    }
  }
  async function add(file: File) {
    if (busy) return;
    busy = true;
    status = 'Checking PDF…';
    let loaded: PDFDocumentProxy | undefined;
    try {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')
        throw new Error('Choose a PDF document.');
      await prepareReader();
      loaded = await loadPdf(file);
      const id = await fingerprint(
        file,
        (n) => (status = `Preparing local copy · ${Math.round(n * 100)}%`),
      );
      const now = Date.now();
      const meta: DocumentMeta = {
        id,
        name: file.name,
        size: file.size,
        pageCount: loaded.numPages,
        addedAt: now,
        lastOpened: now,
        progress: defaultProgress(),
        available: true,
      };
      status = 'Saving PDF to this device…';
      const saved = await importDocument(meta, file);
      pdf = loaded;
      active = saved;
      loaded = undefined;
      await setSetting('lastDocument', id);
      await refresh();
      void navigator.storage?.persist?.().catch(() => {});
    } catch (e) {
      showError(e);
      if (loaded) await loaded.loadingTask.destroy();
    } finally {
      busy = false;
    }
  }
  async function remove() {
    if (!removeTarget) return;
    try {
      await removeDocument(removeTarget.id);
      removeTarget = null;
      await refresh();
    } catch (e) {
      showError(e);
    }
  }
  async function backup() {
    try {
      await initCore();
      downloadBackup(await exportBackup(), 'LWPDFReader-library');
    } catch (e) {
      showError(e);
    }
  }
  async function restore(file: File) {
    busy = true;
    status = 'Validating annotation backup…';
    try {
      if (file.size > 50 * 1024 * 1024)
        throw new Error(
          'Backup is larger than the 50 MB safety limit. Import document backups separately.',
        );
      await initCore();
      const count = await importBackup(JSON.parse(await file.text()));
      await refresh();
      notice = `Restored ${count} annotations. If a PDF is missing, import its original file to reconnect it.`;
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
    }
  }
  function focusDialog(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement | null;
    node.querySelector<HTMLButtonElement>('button')?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') removeTarget = null;
      if (e.key === 'Tab') {
        const buttons = [...node.querySelectorAll<HTMLButtonElement>('button')];
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    node.addEventListener('keydown', key);
    return {
      destroy() {
        node.removeEventListener('keydown', key);
        previous?.focus();
      },
    };
  }
  onMount(() => {
    void (async () => {
      try {
        theme =
          (await getSetting<string>('theme')) ??
          (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        await refresh();
        ready = true;
        const last = await getSetting<string>('lastDocument');
        busy = false;
        const doc = documents.find((d) => d.id === last && d.available);
        if (doc) await open(doc);
      } catch (e) {
        showError(e);
      } finally {
        busy = false;
      }
    })();
    updateSW = registerSW({
      onNeedRefresh() {
        updateAvailable = true;
      },
      onOfflineReady() {
        offlineReady = true;
      },
      onRegisterError(e) {
        console.warn('Offline installation failed', e);
        notice = 'Offline setup did not finish. Reconnect and reload to try again.';
      },
    });
  });
</script>

{#if active && pdf && Reader}{#key active.id}<Reader
      doc={active}
      {pdf}
      onBack={back}
      onError={showError}
      {theme}
      onTheme={toggleTheme}
    />{/key}
{:else if ready}<Library
    {documents}
    {busy}
    {status}
    {usage}
    {theme}
    onImport={add}
    onOpen={open}
    onDelete={(d) => (removeTarget = d)}
    onExport={backup}
    onRestore={restore}
    onTheme={toggleTheme}
    onPersist={protect}
  />
{:else}<main class="startup">
    <Icon name="book" size={40} />
    <h1>LWPDFReader</h1>
    <p>{error ? 'Your library could not be opened. Reload to retry.' : status}</p>
  </main>{/if}
{#if error}<div class="global-message error" role="alert">
    <Icon name="info" size={20} /><span>{error}</span><button
      class="icon-button"
      aria-label="Dismiss error"
      onclick={() => (error = '')}><Icon name="close" size={18} /></button
    >
  </div>{/if}
{#if notice}<div class="global-message" role="status">
    <span>{notice}</span><button
      class="icon-button"
      aria-label="Dismiss message"
      onclick={() => (notice = '')}><Icon name="close" size={18} /></button
    >
  </div>{/if}
{#if updateAvailable}<div class="update-banner" role="status">
    An app update is ready. Return to the library, then update.{#if !active}<button
        onclick={() => updateSW(true)}>Update now</button
      >{/if}
  </div>{:else if offlineReady && !active}<div class="offline-ready">
    Ready to read offline
  </div>{/if}
{#if removeTarget}<div class="modal-backdrop">
    <div
      role="alertdialog"
      tabindex="-1"
      use:focusDialog
      aria-modal="true"
      aria-labelledby="delete-title"
      class="dialog"
    >
      <h2 id="delete-title">Remove this document?</h2>
      <p>
        “{removeTarget.name}” and its annotations and whiteboard links will be removed from this
        device. Linked whiteboards remain available. Export a backup first if you need to keep your
        notes.
      </p>
      <div>
        <button class="secondary-button" onclick={() => (removeTarget = null)}>Keep document</button
        ><button class="primary-button destructive" onclick={remove}>Remove document</button>
      </div>
    </div>
  </div>{/if}
