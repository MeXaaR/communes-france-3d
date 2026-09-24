// Bump this name when prepared geometry or raster formats change.
export const CACHE_NAME = 'communes-france-3d-v1';
export const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const MiB = 1024 ** 2;
interface Metadata {
  key: string;
  bytes: number;
  expires: number;
  used: number;
}
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const completed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? Error('Stockage indisponible'));
  });
export class PersistentCache {
  private database?: Promise<IDBDatabase>;
  private epoch = 0;
  private generation = 0;
  private paused = false;
  private queue: Promise<unknown> = Promise.resolve();
  stats = { hits: 0, misses: 0, writes: 0, failures: 0, evictions: 0 };
  constructor(
    public name = CACHE_NAME,
    public maxBytes = 256 * MiB,
    private now = Date.now,
  ) {}
  private open() {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('data'))
          request.result.createObjectStore('data');
        if (!request.result.objectStoreNames.contains('metadata'))
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        if (!request.result.objectStoreNames.contains('state'))
          request.result.createObjectStore('state');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        const tx = request.result.transaction('state');
        const done = completed(tx);
        void done.catch(() => {});
        result(tx.objectStore('state').get('generation'))
          .then(async (generation) => {
            await done;
            this.generation = generation ?? 0;
            resolve(request.result);
          })
          .catch(reject);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Stockage occupé'));
    }));
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async get<T>(key: string): Promise<T | undefined> {
    if (this.paused) return;
    const epoch = this.epoch;
    try {
      return await this.serial(async () => {
        const db = await this.open();
        if (epoch !== this.epoch || this.paused) return;
        const tx = db.transaction(['metadata', 'data'], 'readwrite'),
          done = completed(tx);
        void done.catch(() => {});
        const meta = tx.objectStore('metadata'),
          data = tx.objectStore('data');
        // Queue both requests while the transaction is active.
        const [entry, value] = await Promise.all([
          result(meta.get(key)) as Promise<Metadata | undefined>,
          result(data.get(key)) as Promise<T | undefined>,
        ]);
        if (!entry || entry.expires <= this.now() || value === undefined) {
          meta.delete(key);
          data.delete(key);
          this.stats.misses++;
          await done;
          return;
        }
        meta.put({ ...entry, used: this.now() });
        await done;
        if (epoch !== this.epoch || this.paused) return;
        this.stats.hits++;
        return value;
      });
    } catch {
      this.stats.failures++;
      return;
    }
  }
  private async put<T>(key: string, value: T, bytes: number, epoch: number, ttl: number) {
    if (this.paused || epoch !== this.epoch || bytes > this.maxBytes) return;
    try {
      await this.serial(async () => {
        const db = await this.open();
        if (this.paused || epoch !== this.epoch) return;
        const tx = db.transaction(['metadata', 'data', 'state'], 'readwrite'),
          done = completed(tx);
        // Attach a handler immediately, including when serialization fails below.
        void done.catch(() => {});
        try {
          const meta = tx.objectStore('metadata'),
            data = tx.objectStore('data');
          const [entries, generation] = await Promise.all([
            result(meta.getAll()) as Promise<Metadata[]>,
            result(tx.objectStore('state').get('generation')),
          ]);
          // An older tab or pending load cannot repopulate data erased in another tab.
          if ((generation ?? 0) !== this.generation) {
            this.pause();
            await done;
            return;
          }
          let total = entries.reduce((n, e) => n + (e.key === key ? 0 : e.bytes), 0);
          const candidates = entries.filter((e) => e.key !== key).sort((a, b) => a.used - b.used);
          for (const e of candidates) {
            if (e.expires <= this.now() || total + bytes > this.maxBytes) {
              meta.delete(e.key);
              data.delete(e.key);
              total -= e.bytes;
              this.stats.evictions++;
            }
          }
          data.put(value, key);
          meta.put({ key, bytes, used: this.now(), expires: this.now() + ttl });
          await done;
          this.stats.writes++;
        } catch (error) {
          try {
            tx.abort();
          } catch {}
          throw error;
        }
      });
    } catch {
      this.stats.failures++;
    }
  }
  async remember<T>(
    key: string,
    loader: () => Promise<T>,
    weight: (value: T) => number,
    signal?: AbortSignal,
    ttl = CACHE_TTL,
  ): Promise<T> {
    signal?.throwIfAborted();
    const epoch = this.epoch;
    const saved = await this.get<T>(key);
    signal?.throwIfAborted();
    if (saved !== undefined) return saved;
    const value = await loader();
    signal?.throwIfAborted();
    // Await structured cloning before the renderer can mutate positions for terrain alignment.
    await this.put(key, value, weight(value), epoch, ttl);
    signal?.throwIfAborted();
    return value;
  }
  pause() {
    this.paused = true;
    this.epoch++;
  }
  async clear() {
    // Keep the current map usable, but do not refill storage until the next page load.
    this.pause();
    await this.serial(async () => {
      const db = await this.open(),
        tx = db.transaction(['metadata', 'data', 'state'], 'readwrite');
      const done = completed(tx);
      void done.catch(() => {});
      const state = tx.objectStore('state');
      const generation = (await result(state.get('generation'))) ?? 0;
      state.put(generation + 1, 'generation');
      tx.objectStore('metadata').clear();
      tx.objectStore('data').clear();
      await done;
    });
  }
  async snapshot() {
    try {
      const db = await this.open(),
        tx = db.transaction('metadata'),
        done = completed(tx);
      void done.catch(() => {});
      const entries = (await result(tx.objectStore('metadata').getAll())) as Metadata[];
      await done;
      return {
        ...this.stats,
        entries: entries.length,
        bytes: entries.reduce((n, e) => n + e.bytes, 0),
        maxBytes: this.maxBytes,
        paused: this.paused,
      };
    } catch {
      return {
        ...this.stats,
        entries: 0,
        bytes: 0,
        maxBytes: this.maxBytes,
        paused: this.paused,
        unavailable: true,
      };
    }
  }
}
export const persistentCache = new PersistentCache(
  CACHE_NAME,
  typeof matchMedia !== 'undefined' && matchMedia('(max-width:650px)').matches
    ? 80 * MiB
    : 256 * MiB,
);
const channel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CACHE_NAME)
    : null;
if (channel) channel.onmessage = () => persistentCache.pause();
export async function clearPersistentData() {
  persistentCache.pause();
  channel?.postMessage('clear');
  await persistentCache.clear();
}
