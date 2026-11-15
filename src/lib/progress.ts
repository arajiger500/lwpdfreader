import type { Progress } from './types';
/** Coalesces for 600ms without starving saves during continuous scrolling. */
export class ProgressWriter {
  private pending?: { value: Progress; sequence: number };
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private write: (p: Progress) => Promise<void>,
    private onError: (e: unknown) => void,
  ) {}
  schedule(p: Progress) {
    this.pending = { value: { ...p }, sequence: ++this.sequence };
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 600);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const job = this.pending;
    this.pending = undefined;
    if (job)
      this.chain = this.chain
        .then(() => this.write(job.value))
        .catch((e) => {
          // A failed old write must never overwrite a newer queued location on retry.
          if (job.sequence === this.sequence && !this.pending) this.pending = job;
          this.onError(e);
        });
    return this.chain;
  }
}
