interface Job {
  priority: number;
  signal: AbortSignal;
  run: () => Promise<void>;
  resolve: () => void;
  removeAbort: () => void;
  reject: (e: unknown) => void;
}
/** At most two canvas/text render jobs run together; canceled queued work never starts. */
export class RenderQueue {
  private active = 0;
  private jobs: Job[] = [];
  run(priority: number, signal: AbortSignal, run: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const cancel = () => {
        const index = this.jobs.indexOf(job);
        if (index >= 0) this.jobs.splice(index, 1);
        resolve();
      };
      const job: Job = {
        priority,
        signal,
        run,
        resolve,
        reject,
        removeAbort: () => signal.removeEventListener('abort', cancel),
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.jobs.push(job);
      this.pump();
    });
  }
  private pump() {
    if (this.active >= 2) return;
    this.jobs.sort((a, b) => a.priority - b.priority);
    while (this.active < 2 && this.jobs.length) {
      const job = this.jobs.shift()!;
      job.removeAbort();
      if (job.signal.aborted) {
        job.resolve();
        continue;
      }
      this.active++;
      void job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
