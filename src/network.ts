export const network = { requests: 0, bytes: 0, failures: 0, active: 0, peak: 0 };
class Queue {
  active = 0;
  lastStart = 0;
  waiting: { run: () => void; signal?: AbortSignal; reject: (e: unknown) => void }[] = [];
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.waiting.push({ run: resolve, signal, reject });
      this.next();
    });
    try {
      const delay = Math.max(0, this.lastStart + 450 - Date.now());
      this.lastStart = Date.now() + delay;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      signal?.throwIfAborted();
      return await fn();
    } finally {
      this.active--;
      this.next();
    }
  }
  private next() {
    while (this.active < 2 && this.waiting.length) {
      const job = this.waiting.shift()!;
      if (job.signal?.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      this.active++;
      job.run();
    }
  }
}
const queue = new Queue();
export async function request(
  url: string,
  signal?: AbortSignal,
  options: RequestInit = {},
): Promise<Response> {
  return queue.run(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      network.requests++;
      network.active++;
      network.peak = Math.max(network.peak, network.active);
      try {
        const response = await fetch(url, {
          ...options,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
            : AbortSignal.timeout(25000),
          credentials: 'omit',
        });
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
            continue;
          }
        }
        if (!response.ok) throw Error(`${new URL(url).hostname} : ${response.status}`);
        return response;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt === 3) {
          network.failures++;
          throw error;
        }
      } finally {
        network.active--;
      }
    }
    throw Error('Service indisponible');
  }, signal);
}
export async function fetchJson<T = any>(
  url: string,
  signal?: AbortSignal,
  options?: RequestInit,
): Promise<T> {
  const response = await request(url, signal, options);
  const text = await response.text();
  network.bytes += text.length;
  return JSON.parse(text);
}
export async function fetchBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await request(url, signal);
  const b = await response.arrayBuffer();
  network.bytes += b.byteLength;
  return b;
}
