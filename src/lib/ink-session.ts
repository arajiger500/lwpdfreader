import { writable, type Subscriber } from 'svelte/store';
import { loadPageInk, applyInkChange } from './ink-storage';
import { strokeOrder, type InkChange, type Stroke } from './ink-types';
export interface InkPageState {
  strokes: Stroke[];
  loaded: boolean;
  error: string | null;
}
export interface InkStatus {
  pending: number;
  failed: boolean;
  canUndo: boolean;
  canRedo: boolean;
  historyActions: number;
}
interface Page {
  state: InkPageState;
  store: ReturnType<typeof writable<InkPageState>>;
  users: number;
  used: number;
  loading?: Promise<void>;
}
interface Job {
  change: InkChange;
  kind: 'edit' | 'undo' | 'redo';
  entry?: InkChange;
}
export class InkSession {
  readonly status = writable<InkStatus>({
    pending: 0,
    failed: false,
    canUndo: false,
    canRedo: false,
    historyActions: 0,
  });
  private pages = new Map<number, Page>();
  private queue: Job[] = [];
  private undoStack: InkChange[] = [];
  private redoStack: InkChange[] = [];
  private running?: Promise<void>;
  private failure = false;
  private historyPoints = 0;
  private historyBusy = false;
  private historyPage: number | undefined;
  penActive = false;
  penFinishedAt = -Infinity;
  constructor(
    readonly documentId: string,
    private onError: (error: unknown) => void,
  ) {}
  get inputBlocked() {
    return this.failure || this.historyBusy;
  }
  get failed() {
    return this.failure;
  }
  private page(n: number): Page {
    let page = this.pages.get(n);
    if (!page) {
      const state: InkPageState = { strokes: [], loaded: false, error: null };
      page = { state, store: writable(state), users: 0, used: Date.now() };
      this.pages.set(n, page);
    }
    page.used = Date.now();
    return page;
  }
  private async load(n: number) {
    const page = this.page(n);
    if (page.state.loaded) return;
    if (page.loading) return page.loading;
    page.loading = loadPageInk(this.documentId, n)
      .then((strokes) => {
        page.state = { strokes, loaded: true, error: null };
        page.store.set(page.state);
      })
      .catch((e) => {
        page.state = { ...page.state, error: e instanceof Error ? e.message : String(e) };
        page.store.set(page.state);
        this.failure = true;
        this.publish();
        this.onError(e);
      })
      .finally(() => {
        page.loading = undefined;
        this.evict();
      });
    return page.loading;
  }
  subscribePage(n: number, run: Subscriber<InkPageState>) {
    const page = this.page(n);
    page.users++;
    const off = page.store.subscribe(run);
    void this.load(n);
    return () => {
      off();
      page.users--;
      this.evict();
    };
  }
  private evict() {
    const unused = [...this.pages]
      .filter(
        ([n, p]) =>
          !p.users &&
          !p.loading &&
          n !== this.historyPage &&
          !this.queue.some((j) => j.change.page === n),
      )
      .sort((a, b) => a[1].used - b[1].used);
    while (this.pages.size > 12 && unused.length) this.pages.delete(unused.shift()![0]);
  }
  private apply(change: InkChange) {
    const page = this.page(change.page);
    const removed = new Set(change.before.map((s) => s.id));
    const added = new Set(change.after.map((s) => s.id));
    page.state = {
      ...page.state,
      strokes: [
        ...page.state.strokes.filter((s) => !removed.has(s.id) && !added.has(s.id)),
        ...change.after,
      ].sort(strokeOrder),
    };
    page.store.set(page.state);
  }
  private publish() {
    this.status.set({
      pending: this.queue.length,
      failed: this.failure,
      canUndo: !this.failure && !this.historyBusy && !this.queue.length && !!this.undoStack.length,
      canRedo: !this.failure && !this.historyBusy && !this.queue.length && !!this.redoStack.length,
      historyActions: this.undoStack.length,
    });
  }
  commit(change: InkChange, finishingActiveStroke = false) {
    if (this.historyBusy) throw new Error('Undo or redo is still finishing. Wait before drawing.');
    if (this.failure && !finishingActiveStroke)
      throw new Error('Retry unsaved ink before drawing again.');
    if (!this.page(change.page).state.loaded) throw new Error('Ink is still loading.');
    if (change.documentId !== this.documentId) throw new Error('Wrong ink session.');
    if (!change.before.length && !change.after.length) return;
    this.redoStack = [];
    this.enqueue({ change, kind: 'edit' });
  }
  private enqueue(job: Job) {
    this.apply(job.change);
    this.queue.push(job);
    this.publish();
    void this.drain();
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.queue.length && !this.failure) {
        const job = this.queue[0];
        try {
          const saved = await applyInkChange(job.change);
          const page = this.pages.get(job.change.page);
          if (page) {
            const stamped = new Map(saved.map((s) => [s.id, s]));
            page.state = {
              ...page.state,
              strokes: page.state.strokes.map((s) => stamped.get(s.id) ?? s),
            };
            page.store.set(page.state);
          }
          this.queue.shift();
          if (job.kind === 'edit') {
            const entry = { ...job.change, after: saved };
            const previous = this.undoStack.at(-1);
            const sameGesture =
              previous &&
              !previous.before.length &&
              !entry.before.length &&
              previous.page === entry.page &&
              previous.after[0]?.rootId === entry.after[0]?.rootId;
            if (sameGesture) {
              previous.after.push(...saved);
              this.historyPoints += saved.reduce((n, s) => n + s.points.length, 0);
            } else {
              this.undoStack.push(entry);
              this.historyPoints += this.points(entry);
            }
            while (this.undoStack.length > 80 || this.historyPoints > 200_000) {
              const old = this.undoStack.shift()!;
              this.historyPoints -= this.points(old);
            }
          } else if (job.kind === 'undo') {
            const old = this.undoStack.pop()!;
            this.historyPoints -= this.points(old);
            this.redoStack.push(old);
          } else {
            const old = this.redoStack.pop()!;
            this.undoStack.push(old);
            this.historyPoints += this.points(old);
          }
        } catch (e) {
          this.failure = true;
          this.onError(e);
        }
        this.publish();
      }
      this.evict();
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private points(c: InkChange) {
    return [...c.before, ...c.after].reduce((sum, s) => sum + s.points.length, 0);
  }
  async flush(): Promise<boolean> {
    await this.drain();
    return !this.queue.length;
  }
  async retry() {
    this.failure = false;
    this.publish();
    await Promise.all(
      [...this.pages].filter(([, p]) => p.users && !p.state.loaded).map(([n]) => this.load(n)),
    );
    await this.drain();
  }
  private async history(direction: 'undo' | 'redo') {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack;
    if (this.failure || this.historyBusy || this.queue.length || !stack.length) return;
    const entry = stack.at(-1)!;
    this.historyBusy = true;
    this.historyPage = entry.page;
    this.publish();
    try {
      await this.load(entry.page);
      if (!this.page(entry.page).state.loaded) return;
      this.enqueue({
        change:
          direction === 'undo'
            ? {
                documentId: this.documentId,
                page: entry.page,
                before: entry.after,
                after: entry.before,
              }
            : entry,
        kind: direction,
        entry,
      });
      await this.flush();
    } finally {
      this.historyBusy = false;
      this.historyPage = undefined;
      this.publish();
      this.evict();
    }
  }
  async clearPage(page: number) {
    await this.load(page);
    const before = this.page(page).state.strokes;
    this.commit({ documentId: this.documentId, page, before, after: [] });
    return this.flush();
  }
  async undo() {
    await this.history('undo');
  }
  async redo() {
    await this.history('redo');
  }
  stats() {
    return {
      cachedPages: this.pages.size,
      historyPoints: this.historyPoints,
      pending: this.queue.length,
    };
  }
}
