<script lang="ts">
  import { onMount } from 'svelte';
  import { listBoards } from '../lib/whiteboard-storage';
  import type { Whiteboard } from '../lib/whiteboard-storage';

  let {
    onAttach,
    onClose,
    onError,
  }: {
    onAttach: (choice: { title: string } | { boardId: string }) => Promise<void>;
    onClose: () => void;
    onError: (error: unknown) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let title = $state('Whiteboard');
  let boards = $state<Whiteboard[]>([]);
  let selected = $state('');
  let working = $state(false);
  let error = $state('');
  async function submit() {
    working = true;
    error = '';
    try {
      await onAttach(selected ? { boardId: selected } : { title });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      working = false;
    }
  }
  onMount(() => {
    dialog.showModal();
    void listBoards()
      .then((items) => (boards = items))
      .catch(onError);
  });
</script>

<dialog
  class="attach-board"
  aria-label="Attach whiteboard"
  bind:this={dialog}
  oncancel={(e) => {
    e.preventDefault();
    if (!working) onClose();
  }}
>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <h2>Attach whiteboard</h2>
    {#if boards.length}
      <label
        >Whiteboard
        <select bind:value={selected}>
          <option value="">Create a new whiteboard</option>
          {#each boards as board (board.id)}<option value={board.id}>{board.title}</option>{/each}
        </select>
      </label>
    {/if}
    {#if !selected}<label>Title <input bind:value={title} required maxlength="120" /></label>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <footer>
      <button type="button" onclick={onClose} disabled={working}>Cancel</button>
      <button type="submit" disabled={working}
        >{selected ? 'Link whiteboard' : 'Create whiteboard'}</button
      >
    </footer>
  </form>
</dialog>
