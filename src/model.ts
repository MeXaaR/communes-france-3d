import earcut from 'earcut';
import clipping from 'polygon-clipping';
import type { FeatureCollection, Feature, Position } from 'geojson';
import {
  type Area,
  type Bounds,
  contains,
  mercator,
  lngLat,
  hash,
  geometryCenter,
  boundsOf,
} from './geo';
import type { CoverTile } from './rasters';
export function clip(data: FeatureCollection, boundary: Area): FeatureCollection {
  const region = boundary.type === 'Polygon' ? [boundary.coordinates] : boundary.coordinates;
  const features: Feature[] = [];
  for (const f of data.features) {
    if (!['Polygon', 'MultiPolygon'].includes(f.geometry.type)) continue;
    const g = f.geometry as Area;
    try {
      const coordinates = clipping.intersection(
        (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as any,
        region as any,
      );
      if (coordinates.length)
        features.push({ ...f, geometry: { type: 'MultiPolygon', coordinates } });
    } catch {
      throw Error('Contour géométrique invalide dans la source officielle');
    }
  }
  return { type: 'FeatureCollection', features };
}
export interface Ground {
  bounds: Bounds;
  size: number;
  values: number[];
}
export function altitude(p: Position, grid: Ground): number {
  const b = grid.bounds,
    n = grid.size;
  const x = Math.max(0, Math.min(n - 1, ((p[0] - b[0]) / (b[2] - b[0])) * (n - 1))),
    y = Math.max(0, Math.min(n - 1, ((p[1] - b[1]) / (b[3] - b[1])) * (n - 1)));
  const i = Math.min(n - 2, Math.floor(x)),
    j = Math.min(n - 2, Math.floor(y)),
    u = x - i,
    v = y - j;
  return (
    grid.values[j * n + i] * (1 - u) * (1 - v) +
    grid.values[j * n + i + 1] * u * (1 - v) +
    grid.values[(j + 1) * n + i] * (1 - u) * v +
    grid.values[(j + 1) * n + i + 1] * u * v
  );
}
export function coverClass(p: Position, tiles: CoverTile[]): number {
  for (const t of tiles) {
    const b = t.bounds;
    if (p[0] >= b[0] && p[0] < b[2] && p[1] >= b[1] && p[1] < b[3]) {
      const x = Math.min(t.size - 1, Math.floor(((p[0] - b[0]) / (b[2] - b[0])) * t.size)),
        y = Math.min(t.size - 1, Math.floor(((b[3] - p[1]) / (b[3] - b[1])) * t.size));
      return t.classes[y * t.size + x];
    }
  }
  return 0;
}
export interface ModelInput {
  buildings: FeatureCollection;
  boundary: Area;
  origin: [number, number];
  bounds: Bounds;
  covers: CoverTile[];
  ground: Ground;
  forests: FeatureCollection;
  limit: number;
  treeLimit: number;
  maxVertices?: number;
  obstacles?: FeatureCollection;
}
export interface Tree {
  x: number;
  y: number;
  z: number;
  height: number;
  radius: number;
  conifer: boolean;
  seed: number;
  lon: number;
  lat: number;
  source: string;
}
export function generate(input: ModelInput) {
  const { origin, bounds, ground } = input,
    center = mercator(origin),
    scale = Math.cos((origin[1] * Math.PI) / 180),
    positions: number[] = [],
    colors: number[] = [],
    trees: Tree[] = [],
    spans: {
      start: number;
      end: number;
      base: number;
      lon: number;
      lat: number;
      offset: number;
    }[] = [];
  const local = (p: Position): number[] => {
    const m = mercator(p);
    return [(m[0] - center[0]) * scale, (m[1] - center[1]) * scale];
  };
  const rgb = (s: string) =>
    [0, 2, 4].map((i) => {
      const v = parseInt(s.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  const walls = ['d4c8ae', 'c8bca3', 'cec4b3', 'd8ccbb', 'bfb8a5'].map(rgb),
    roofs = ['657178', '737e82', '596971', '7c827f', '967b68'].map(rgb),
    glass = rgb('465c62'),
    frame = rgb('d6d3bd');
  const tri = (a: number[], b: number[], c: number[], color: number[]) => {
    positions.push(...a, ...b, ...c);
    colors.push(...color, ...color, ...color);
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], color: number[]) => {
    tri(a, b, c, color);
    tri(a, c, d, color);
  };
  const known = input.buildings.features
    .filter((f) => f.properties?.height > 0)
    .sort((a, b) => {
      const pa = local(geometryCenter(a.geometry as Area)),
        pb = local(geometryCenter(b.geometry as Area));
      return pa[0] ** 2 + pa[1] ** 2 - pb[0] ** 2 - pb[1] ** 2;
    })
    .slice(0, input.limit);
  let roofCount = 0,
    windowCount = 0;
  const ids: string[] = [];
  let minHeight = Infinity,
    maxHeight = 0;
  for (const f of known) {
    if (positions.length / 3 >= (input.maxVertices ?? Infinity)) break;
    const props = f.properties!,
      id = String(props.id),
      seed = hash(id),
      height = Number(props.height),
      c = geometryCenter(f.geometry as Area),
      m = mercator(c),
      sample = altitude(m, ground),
      base = Number.isFinite(sample) ? sample : Number(props.groundMin) || 0;
    const start = positions.length;
    ids.push(id);
    minHeight = Math.min(minHeight, height);
    maxHeight = Math.max(maxHeight, height);
    const polygons =
      (f.geometry as Area).type === 'Polygon'
        ? [(f.geometry as any).coordinates]
        : (f.geometry as any).coordinates;
    for (const polygon of polygons) {
      const rings: number[][][] = polygon.map((r: Position[]) => r.slice(0, -1).map(local));
      if (rings[0].length < 3) continue;
      let axis = [1, 0],
        longest = 0,
        area = 0;
      for (let i = 0; i < rings[0].length; i++) {
        const a = rings[0][i],
          b = rings[0][(i + 1) % rings[0].length],
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          len = Math.hypot(dx, dy);
        if (len > longest) {
          longest = len;
          axis = [dx / len, dy / len];
        }
        area += a[0] * b[1] - b[0] * a[1];
      }
      const normal = [-axis[1], axis[0]],
        projected = rings[0].map((p) => p[0] * normal[0] + p[1] * normal[1]),
        low = Math.min(...projected),
        high = Math.max(...projected),
        mid = (low + high) / 2,
        half = (high - low) / 2;
      const rise =
          Math.abs(area) / 2 < 700 && height < 22 && half > 1
            ? Math.min(2.5, half * 0.5, height * 0.3)
            : 0,
        eaves = base + height - rise;
      const top = (p: number[]) =>
        eaves +
        (rise
          ? rise * Math.max(0, 1 - Math.abs((p[0] * normal[0] + p[1] * normal[1] - mid) / half))
          : 0);
      // Split the roof at its ridge, so concave outlines and courtyard holes remain intact.
      const flat = rings.map((r) => [...r, r[0]]);
      let parts = [flat];
      if (rise) {
        const ext = 100000;
        const ridge = [normal[0] * mid, normal[1] * mid];
        const cut = (sign: number) => [
          [ridge[0] - axis[0] * ext, ridge[1] - axis[1] * ext],
          [ridge[0] + axis[0] * ext, ridge[1] + axis[1] * ext],
          [
            ridge[0] + axis[0] * ext + normal[0] * ext * sign,
            ridge[1] + axis[1] * ext + normal[1] * ext * sign,
          ],
          [
            ridge[0] - axis[0] * ext + normal[0] * ext * sign,
            ridge[1] - axis[1] * ext + normal[1] * ext * sign,
          ],
          [ridge[0] - axis[0] * ext, ridge[1] - axis[1] * ext],
        ];
        parts = [
          ...clipping.intersection([flat] as any, [[cut(1)]] as any),
          ...clipping.intersection([flat] as any, [[cut(-1)]] as any),
        ] as number[][][][];
        roofCount++;
      }
      for (const part of parts) {
        const vertices: number[] = [],
          holes: number[] = [];
        for (const [ri, ring] of part.entries()) {
          if (ri) holes.push(vertices.length / 2);
          for (const p of ring.slice(0, -1)) vertices.push(p[0], p[1]);
        }
        const indices = earcut(vertices, holes, 2);
        for (let i = 0; i < indices.length; i += 3) {
          const pts = indices
            .slice(i, i + 3)
            .map((k) => [
              vertices[k * 2],
              vertices[k * 2 + 1],
              top([vertices[k * 2], vertices[k * 2 + 1]]),
            ]);
          tri(pts[0], pts[1], pts[2], roofs[seed % roofs.length]);
        }
      }
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i],
            b = ring[(i + 1) % ring.length],
            dx = b[0] - a[0],
            dy = b[1] - a[1],
            len = Math.hypot(dx, dy);
          if (len < 0.1) continue;
          const da = a[0] * normal[0] + a[1] * normal[1] - mid,
            db = b[0] * normal[0] + b[1] * normal[1] - mid;
          const points = [a];
          if (rise && da * db < 0) {
            const t = da / (da - db);
            points.push([a[0] + dx * t, a[1] + dy * t]);
          }
          points.push(b);
          for (let j = 0; j < points.length - 1; j++) {
            const p = points[j],
              q = points[j + 1];
            quad(
              [p[0], p[1], base - 8],
              [q[0], q[1], base - 8],
              [q[0], q[1], top(q)],
              [p[0], p[1], top(p)],
              walls[seed % walls.length],
            );
          }
          if (len < 3 || height < 3 || Math.abs(area) / 2 > 3000) continue;
          const nx = dy / len,
            ny = -dx / len,
            columns = Math.min(18, Math.floor(len / 3.3)),
            rows = Math.min(18, Math.floor((height - rise) / 3));
          for (let col = 1; col <= columns; col++)
            for (let row = 0; row < rows; row++) {
              if (positions.length / 3 >= (input.maxVertices ?? Infinity)) continue;
              const t = col / (columns + 1),
                x = a[0] + dx * t,
                y = a[1] + dy * t,
                z = base + 1.2 + row * 3;
              if (z + 1.35 >= eaves) continue;
              for (const [width, h, offset, color] of [
                [1.05, 1.32, 0.04, frame],
                [0.8, 1.06, 0.065, glass],
              ] as [number, number, number, number[]][]) {
                const ux = ((dx / len) * width) / 2,
                  uy = ((dy / len) * width) / 2;
                for (const sign of [-1, 1])
                  quad(
                    [x - ux + nx * offset * sign, y - uy + ny * offset * sign, z],
                    [x + ux + nx * offset * sign, y + uy + ny * offset * sign, z],
                    [x + ux + nx * offset * sign, y + uy + ny * offset * sign, z + h],
                    [x - ux + nx * offset * sign, y - uy + ny * offset * sign, z + h],
                    color,
                  );
              }
              windowCount++;
            }
        }
    }
    spans.push({ start, end: positions.length, base, lon: c[0], lat: c[1], offset: 0 });
  }
  const forest = input.forests.features.map((f) => ({
    geometry: f.geometry as Area,
    bounds: boundsOf(f.geometry),
  }));
  const structures = (input.obstacles ?? input.buildings).features.map((f) => ({
    geometry: f.geometry as Area,
    bounds: boundsOf(f.geometry),
  }));
  const forestAt = (p: Position) => {
    const point = lngLat(p[0], p[1]);
    if (
      structures.some(
        (f) =>
          point[0] >= f.bounds[0] &&
          point[0] <= f.bounds[2] &&
          point[1] >= f.bounds[1] &&
          point[1] <= f.bounds[3] &&
          contains(point, f.geometry),
      )
    )
      return null;
    const category = coverClass(p, input.covers);
    if (category) return category === 8 || category === 9 ? { category, source: 'CoSIA' } : null;
    const ll = lngLat(p[0], p[1]);
    return forest.some(
      (f) =>
        ll[0] >= f.bounds[0] &&
        ll[0] <= f.bounds[2] &&
        ll[1] >= f.bounds[1] &&
        ll[1] <= f.bounds[3] &&
        contains(ll, f.geometry),
    )
      ? { category: 9, source: 'BD TOPO' }
      : null;
  };
  // Anchor the distribution to a fixed global grid; panning must not move existing trees.
  const step = 14,
    candidates: Tree[] = [];
  for (let gx = Math.floor(bounds[0] / step); gx <= Math.ceil(bounds[2] / step); gx++)
    for (let gy = Math.floor(bounds[1] / step); gy <= Math.ceil(bounds[3] / step); gy++) {
      const seed = hash(`${gx}/${gy}`),
        x = (gx + 0.2 + (seed % 601) / 1000) * step,
        y = (gy + 0.2 + ((seed >>> 10) % 601) / 1000) * step,
        p = [x, y],
        ll = lngLat(x, y);
      if (x < bounds[0] || x >= bounds[2] || y < bounds[1] || y >= bounds[3]) continue;
      if (!contains(ll, input.boundary)) continue;
      const hit = forestAt(p);
      if (!hit) continue;
      const radius = 2.4 + (seed % 20) / 10,
        clearance = (radius + 2) / scale;
      let fits = true;
      for (let k = 0; k < 8; k++) {
        const q = [
          x + Math.cos((k * Math.PI) / 4) * clearance,
          y + Math.sin((k * Math.PI) / 4) * clearance,
        ];
        if (!forestAt(q) || !contains(lngLat(q[0], q[1]), input.boundary)) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      candidates.push({
        x: (x - center[0]) * scale,
        y: (y - center[1]) * scale,
        z: altitude(p, ground),
        height: 8 + (seed % 75) / 10,
        radius,
        conifer: hit.category === 8,
        seed,
        lon: ll[0],
        lat: ll[1],
        source: hit.source,
      });
    }
  candidates.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y);
  trees.push(...candidates.slice(0, input.treeLimit));
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    trees,
    ids,
    spans,
    stats: {
      buildings: ids.length,
      roofs: roofCount,
      windows: windowCount,
      trees: trees.length,
      treeCandidates: candidates.length,
      minHeight: known.length ? minHeight : 0,
      maxHeight,
      triangles: positions.length / 9,
      finite: positions.every(Number.isFinite) && trees.every((t) => Number.isFinite(t.z)),
      treeSources: [...new Set(trees.map((t) => t.source))],
    },
  };
}
export type ModelResult = ReturnType<typeof generate>;
