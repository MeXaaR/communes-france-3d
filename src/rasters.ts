import { addProtocol } from 'maplibre-gl';
import { tileBounds, WORLD, type Bounds } from './geo';
export interface CoverTile {
  z: number;
  x: number;
  y: number;
  bounds: Bounds;
  classes: Uint8Array;
  size: number;
  source: string;
  known: number;
}
interface Result {
  buffer: ArrayBuffer;
  elevations?: Float32Array;
  classes?: Uint8Array;
  source: string;
  known?: number;
  min?: number;
  max?: number;
  missing?: number;
}
class RasterWorker {
  worker = new Worker(new URL('./raster-worker.ts', import.meta.url), { type: 'module' });
  next = 0;
  jobs = new Map<number, { resolve: (v: Result) => void; reject: (e: unknown) => void }>();
  constructor() {
    this.worker.onmessage = (e) => {
      const job = this.jobs.get(e.data.id);
      if (!job) return;
      this.jobs.delete(e.data.id);
      if (e.data.error)
        job.reject(e.data.aborted ? new DOMException('Annulé', 'AbortError') : Error(e.data.error));
      else job.resolve(e.data.result);
    };
  }
  request(type: string, z: number, x: number, y: number, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => this.worker.postMessage({ type: 'cancel', id });
      this.jobs.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', abort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', abort);
          reject(e);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({ type, z, x, y, id });
    });
  }
}
const workers = [new RasterWorker()];
let workerCursor = 0;
const cache = new Map<string, Result>();
export const rasterStats = {
  terrainTiles: 0,
  coverTiles: 0,
  terrainMin: Infinity,
  terrainMax: -Infinity,
  missingPixels: 0,
  failures: 0,
  coverSources: new Set<string>(),
};
const pending = new Map<
  string,
  { promise: Promise<Result>; control: AbortController; users: number }
>();
async function load(
  type: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Result> {
  signal?.throwIfAborted();
  const key = `${type}/${z}/${x}/${y}`,
    saved = cache.get(key);
  if (saved) return saved;
  let task = pending.get(key);
  if (task?.control.signal.aborted) task = undefined;
  if (!task) {
    const control = new AbortController();
    const created = { control, users: 0, promise: null as unknown as Promise<Result> };
    created.promise = workers[workerCursor++ % workers.length]
      .request(type, z, x, y, control.signal)
      .then((result) => {
        cache.set(key, result);
        while (cache.size > 80) cache.delete(cache.keys().next().value!);
        if (type === 'dem') {
          rasterStats.terrainTiles++;
          rasterStats.terrainMin = Math.min(rasterStats.terrainMin, result.min ?? Infinity);
          rasterStats.terrainMax = Math.max(rasterStats.terrainMax, result.max ?? -Infinity);
          rasterStats.missingPixels += result.missing ?? 0;
        } else {
          rasterStats.coverTiles++;
          rasterStats.coverSources.add(result.source);
        }
        return result;
      })
      .catch((e) => {
        if (!control.signal.aborted) rasterStats.failures++;
        throw e;
      })
      .finally(() => {
        if (pending.get(key) === created) pending.delete(key);
      });
    task = created;
    pending.set(key, task);
  }
  const active = task;
  active.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', abort);
      active.users--;
      if (active.users === 0 && pending.get(key) === active) active.control.abort();
      return true;
    };
    const abort = () => {
      if (finish()) reject(new DOMException('Annulé', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    active.promise.then(
      (r) => {
        if (finish()) resolve(r);
      },
      (e) => {
        if (finish()) reject(e);
      },
    );
  });
}
export function registerRasters() {
  for (const [protocol, type] of [
    ['ign-dem', 'dem'],
    ['ign-cover', 'cover'],
  ])
    addProtocol(protocol, async (params, abort) => {
      const [z, x, y] = params.url.replace(`${protocol}://`, '').split('/').map(Number);
      const r = await load(type, z, x, y, abort.signal);
      return { data: r.buffer.slice(0) };
    });
}
export async function coverForBounds(b: Bounds, signal: AbortSignal): Promise<CoverTile[]> {
  const z = 15,
    unit = WORLD / 2 ** z;
  const tiles: CoverTile[] = [];
  const left = Math.floor((b[0] + WORLD / 2) / unit),
    right = Math.floor((b[2] + WORLD / 2) / unit),
    top = Math.floor((WORLD / 2 - b[3]) / unit),
    bottom = Math.floor((WORLD / 2 - b[1]) / unit);
  const jobs: { x: number; y: number }[] = [];
  for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) jobs.push({ x, y });
  for (let offset = 0; offset < jobs.length; offset += 3)
    await Promise.all(
      jobs.slice(offset, offset + 3).map(async ({ x, y }) => {
        const r = await load('cover', z, x, y, signal);
        tiles.push({
          z,
          x,
          y,
          bounds: tileBounds(z, x, y),
          classes: r.classes!,
          size: 512,
          source: r.source,
          known: r.known ?? 0,
        });
      }),
    );
  return tiles;
}
export const demTiles = ['ign-dem://{z}/{x}/{y}'];
export const coverTiles = ['ign-cover://{z}/{x}/{y}'];
export const orthoTiles = [
  'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
];

export async function groundForBounds(b: Bounds, signal: AbortSignal) {
  const z = 16,
    unit = WORLD / 2 ** z,
    tiles = new Map<string, Float32Array>();
  const left = Math.floor((b[0] + WORLD / 2) / unit),
    right = Math.floor((b[2] + WORLD / 2) / unit),
    top = Math.floor((WORLD / 2 - b[3]) / unit),
    bottom = Math.floor((WORLD / 2 - b[1]) / unit);
  const jobs: { x: number; y: number }[] = [];
  for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) jobs.push({ x, y });
  if (jobs.length > 25) throw Error('Zone de détail trop étendue');
  for (let offset = 0; offset < jobs.length; offset += 3)
    await Promise.all(
      jobs.slice(offset, offset + 3).map(async ({ x, y }) => {
        const r = await load('dem', z, x, y, signal);
        tiles.set(`${x}/${y}`, r.elevations!);
      }),
    );
  const size = 129,
    values: number[] = [];
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const x = b[0] + (i / (size - 1)) * (b[2] - b[0]),
        y = b[1] + (j / (size - 1)) * (b[3] - b[1]),
        tx = Math.floor((x + WORLD / 2) / unit),
        ty = Math.floor((WORLD / 2 - y) / unit),
        bounds = tileBounds(z, tx, ty);
      const px = Math.max(0, Math.min(255, Math.floor(((x - bounds[0]) / unit) * 256))),
        py = Math.max(0, Math.min(255, Math.floor(((bounds[3] - y) / unit) * 256)));
      values.push(tiles.get(`${tx}/${ty}`)?.[py * 256 + px] ?? 0);
    }
  return { bounds: b, size, values };
}
