import type { FeatureCollection } from 'geojson';
import type { ModelInput, ModelResult } from './model';
interface Job {
  id: number;
  input: ModelInput;
  signal: AbortSignal;
  resolve: (r: { model: ModelResult; buildings: FeatureCollection }) => void;
  reject: (e: unknown) => void;
  abort: () => void;
}
export class ModelPool {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private active: Job | null = null;
  private next = 0;
  stats = { builds: 0, workerStarts: 0 };
  run(input: ModelInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<{ model: ModelResult; buildings: FeatureCollection }>((resolve, reject) => {
      const job: Job = {
        id: ++this.next,
        input,
        signal,
        resolve,
        reject,
        abort: () => {
          signal.removeEventListener('abort', job.abort);
          if (this.active === job) {
            this.worker?.terminate();
            this.worker = null;
            this.active = null;
          } else this.queue = this.queue.filter((j) => j !== job);
          reject(new DOMException('Annulé', 'AbortError'));
          this.pump();
        },
      };
      signal.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  private pump() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift()!;
    if (job.signal.aborted) {
      job.abort();
      return;
    }
    this.active = job;
    if (!this.worker) {
      this.worker = new Worker(new URL('./model-worker.ts', import.meta.url), { type: 'module' });
      this.stats.workerStarts++;
    }
    this.worker.onmessage = (e) => {
      if (this.active !== job || e.data.id !== job.id) return;
      job.signal.removeEventListener('abort', job.abort);
      this.active = null;
      if (e.data.error) job.reject(Error(e.data.error));
      else {
        this.stats.builds++;
        job.resolve(e.data);
      }
      this.pump();
    };
    this.worker.onerror = (e) => {
      job.signal.removeEventListener('abort', job.abort);
      this.worker?.terminate();
      this.worker = null;
      this.active = null;
      job.reject(Error(e.message));
      this.pump();
    };
    this.worker.postMessage({ id: job.id, input: job.input });
  }
}
