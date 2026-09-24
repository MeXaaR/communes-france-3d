import type {
  Feature,
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Position,
  Geometry,
} from 'geojson';
export type Area = Polygon | MultiPolygon;
export type Bounds = [number, number, number, number];
export const WORLD = 40075016.68557849;
export const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
export const mercator = (p: Position): [number, number] => [
  (p[0] * WORLD) / 360,
  (Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, p[1])) * Math.PI) / 360)) * WORLD) /
    (2 * Math.PI),
];
export const lngLat = (x: number, y: number): [number, number] => [
  (x / WORLD) * 360,
  ((2 * Math.atan(Math.exp((y / WORLD) * 2 * Math.PI)) - Math.PI / 2) * 180) / Math.PI,
];
export function tileBounds(z: number, x: number, y: number): Bounds {
  const size = WORLD / 2 ** z;
  return [
    x * size - WORLD / 2,
    WORLD / 2 - (y + 1) * size,
    (x + 1) * size - WORLD / 2,
    WORLD / 2 - y * size,
  ];
}
export function boundsOf(geometry: Geometry): Bounds {
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (value: any) => {
    if (typeof value[0] === 'number') {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
    } else for (const child of value) visit(child);
  };
  if ('coordinates' in geometry) visit(geometry.coordinates);
  else
    for (const g of geometry.geometries) {
      const b = boundsOf(g);
      visit([b.slice(0, 2), b.slice(2)]);
    }
  return bounds;
}
export const boxGeometry = (b: Bounds): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
      [b[0], b[1]],
    ],
  ],
});
export function inRing(p: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
export function contains(p: Position, area: Area): boolean {
  const polys = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  return polys.some((poly) => inRing(p, poly[0]) && !poly.slice(1).some((r) => inRing(p, r)));
}
export function hash(text: string): number {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return n >>> 0;
}
export function geometryCenter(g: Area): [number, number] {
  const b = boundsOf(g);
  const point: [number, number] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (contains(point, g)) return point;
  const poly = g.type === 'Polygon' ? g.coordinates : g.coordinates[0];
  return [poly[0][0][0], poly[0][0][1]];
}
export function featureCollection(features: Feature[]): FeatureCollection {
  return { type: 'FeatureCollection', features };
}
export const safeUrl = (value: unknown) => {
  try {
    const u = new URL(String(value));
    return ['https:', 'http:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
};
export const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const normalize = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
