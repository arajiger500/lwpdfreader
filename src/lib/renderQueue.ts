interface Job {
  priority: number;
  signal: AbortSignal;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}
/** At most two canvas/text render jobs run together; canceled queued work never starts. */
export class RenderQueue {
  private active = 0;
  private jobs: Job[] = [];
  run(priority: number, signal: AbortSignal, run: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      this.jobs.push({ priority, signal, run, resolve, reject });
      this.pump();
    });
  }
  private pump() {
    this.jobs.sort((a, b) => a.priority - b.priority);
    while (this.active < 2 && this.jobs.length) {
      const job = this.jobs.shift()!;
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
