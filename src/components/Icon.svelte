<script lang="ts">
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    hand: 'M8 11V5a2 2 0 0 1 4 0v5 M12 8V4a2 2 0 0 1 4 0v7 M16 8a2 2 0 0 1 4 0v7c0 4-3 6-7 6-3 0-4-2-6-4l-4-4a2 2 0 0 1 3-3l2 2z',
    pen: 'm4 16 12-12 4 4-12 12-5 1z M14 6l4 4 M5 15l4 4',
    marker: 'm6 14 9-11 6 5-9 11-6 1z M11 8l6 5 M4 22h14',
    eraser: 'm4 14 10-11 7 7-10 11H9z M8 10l7 7 M12 21h9',
    undo: 'M8 5 3 10l5 5 M3 10h10a6 6 0 0 1 0 12',
    redo: 'm16 5 5 5-5 5 M21 10H11a6 6 0 0 0 0 12',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    collapse: 'm7 9 5 5 5-5',
    book: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z',
    plus: 'M12 5v14 M5 12h14',
    back: 'm14 6-6 6 6 6',
    next: 'm10 6 6 6-6 6',
    sidebar: 'M4 4h16v16H4z M9 4v16',
    bookmark: 'M6 3h12v18l-6-4-6 4z',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
    moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z',
    export: 'M12 15V3 m-4 4 4-4 4 4 M5 13v7h14v-7',
    import: 'M12 3v12 m-4-4 4 4 4-4 M5 17v4h14v-4',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
    trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
    close: 'm6 6 12 12 M6 18 18 6',
    check: 'm5 12 4 4L19 6',
    note: 'M4 3h16v14l-5 4H4z M8 8h8 M8 12h6',
    highlight: 'm5 14 9-10 6 6-10 9H5z M4 21h16 M8 11l5 5',
    region: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
    rotate: 'M20 7v5h-5 M19 12a7 7 0 1 0-2 5',
    focus: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
    file: 'M5 3h9l5 5v13H5z M14 3v6h5 M9 14h6 M9 17h4',
    shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z m-4 9 3 3 5-6',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 m5 12 6 6',
    minus: 'M5 12h14',
    info: 'M12 11v6 M12 7h.01 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] ?? paths.file} /></svg
>
