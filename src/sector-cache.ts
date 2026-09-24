import { WORLD, tileBounds, mercator, lngLat, geometryCenter, type Bounds, type Area } from './geo';
import type { FeatureCollection } from 'geojson';
export const SECTOR_ZOOM = 16;
export interface Sector {
  key: string;
  x: number;
  y: number;
  projected: Bounds;
  geographic: Bounds;
  origin: [number, number];
}
export function sectorAt(point: number[]): Sector {
  const p = mercator(point),
    unit = WORLD / 2 ** SECTOR_ZOOM;
  return sector(Math.floor((p[0] + WORLD / 2) / unit), Math.floor((WORLD / 2 - p[1]) / unit));
}
export function sector(x: number, y: number): Sector {
  const projected = tileBounds(SECTOR_ZOOM, x, y),
    sw = lngLat(projected[0], projected[1]),
    ne = lngLat(projected[2], projected[3]);
  return {
    key: `${x}/${y}`,
    x,
    y,
    projected,
    geographic: [sw[0], sw[1], ne[0], ne[1]],
    origin: lngLat((projected[0] + projected[2]) / 2, (projected[1] + projected[3]) / 2),
  };
}
export function surroundingSectors(point: number[], boundary: Bounds): Sector[] {
  const center = sectorAt(point),
    p = mercator(point);
  const output: Sector[] = [];
  for (let x = center.x - 1; x <= center.x + 1; x++)
    for (let y = center.y - 1; y <= center.y + 1; y++) {
      const tile = sector(x, y),
        b = tile.geographic;
      if (b[0] <= boundary[2] && b[2] >= boundary[0] && b[1] <= boundary[3] && b[3] >= boundary[1])
        output.push(tile);
    }
  return output.sort((a, b) => {
    const distance = (s: Sector) => {
      const c = mercator(s.origin);
      return (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    };
    return distance(a) - distance(b);
  });
}
// Keep entire footprints, including those crossing a tile edge, in exactly one owner sector.
export function ownedFeatures(data: FeatureCollection, tile: Sector): FeatureCollection {
  return {
    ...data,
    features: data.features.filter(
      (f) => sectorAt(geometryCenter(f.geometry as Area)).key === tile.key,
    ),
  };
}
export class SectorCache<T> {
  entries = new Map<string, { value: T; bytes: number }>();
  pending = new Map<string, Promise<T>>();
  bytes = 0;
  protectedKeys = new Set<string>();
  epoch = 0;
  stats = { hits: 0, misses: 0, shared: 0, evictions: 0 };
  constructor(
    public maxBytes: number,
    public maxEntries: number,
    private dispose: (key: string, value: T) => void = () => {},
  ) {}
  protect(keys: Iterable<string>) {
    this.protectedKeys = new Set(keys);
    this.trim();
  }
  has(key: string) {
    return this.entries.has(key);
  }
  touch(key: string) {
    const saved = this.entries.get(key);
    if (!saved) return;
    this.stats.hits++;
    this.entries.delete(key);
    this.entries.set(key, saved);
  }
  peek(key: string) {
    return this.entries.get(key)?.value;
  }
  values() {
    return [...this.entries.values()].map((e) => e.value);
  }
  async get(key: string, loader: () => Promise<T>, weight: (v: T) => number): Promise<T> {
    const saved = this.entries.get(key);
    if (saved) {
      this.touch(key);
      return saved.value;
    }
    const waiting = this.pending.get(key);
    if (waiting) {
      this.stats.shared++;
      return waiting;
    }
    this.stats.misses++;
    const epoch = this.epoch;
    const promise = loader()
      .then((value) => {
        if (epoch !== this.epoch) throw new DOMException('Ancienne commune', 'AbortError');
        const bytes = weight(value);
        this.entries.set(key, { value, bytes });
        this.bytes += bytes;
        this.trim();
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
  private trim() {
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      let key = [...this.entries.keys()].find((k) => !this.protectedKeys.has(k));
      if (key === undefined) key = this.entries.keys().next().value;
      if (key === undefined) break;
      const entry = this.entries.get(key)!;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
      this.stats.evictions++;
      this.dispose(key, entry.value);
    }
  }
  clear() {
    this.epoch++;
    for (const [key, entry] of this.entries) this.dispose(key, entry.value);
    this.entries.clear();
    this.pending.clear();
    this.protectedKeys.clear();
    this.bytes = 0;
  }
  snapshot() {
    return {
      ...this.stats,
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      pending: this.pending.size,
    };
  }
}
