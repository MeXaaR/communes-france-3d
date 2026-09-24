/// <reference lib="webworker" />
import { fromArrayBuffer } from 'geotiff';
import { tileBounds, type Bounds } from './geo';
import { fetchBuffer } from './network';
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const controllers = new Map<number, AbortController>();
const original = [
  [206, 112, 121],
  [152, 119, 82],
  [166, 170, 183],
  [98, 208, 255],
  [187, 176, 150],
  [51, 117, 161],
  [233, 239, 254],
  [18, 100, 33],
  [76, 145, 41],
  [181, 195, 53],
  [176, 130, 144],
  [140, 215, 106],
  [222, 207, 85],
  [208, 163, 73],
  [185, 226, 212],
  [223, 139, 82],
  [34, 34, 34],
];
const palette = [
  '#d9cdc2',
  '#d1cdbf',
  '#d6d4cc',
  '#89bdca',
  '#c7bc9f',
  '#83afc0',
  '#eef4f5',
  '#587c66',
  '#79986a',
  '#a6b58b',
  '#bdc995',
  '#ced5a5',
  '#ded7ae',
  '#c8b993',
  '#c1d6bb',
  '#beaf87',
  '#d4cbb3',
].map((c) => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
]);
export function classify(r: number, g: number, b: number, a: number): number {
  if (a < 100 || (r > 245 && g > 245 && b > 245)) return 0;
  let best = Infinity,
    chosen = 0;
  for (let i = 0; i < original.length; i++) {
    const c = original[i],
      d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < best) {
      best = d;
      chosen = i + 1;
    }
  }
  return best < 3500 ? chosen : 0;
}
function wms(layer: string, b: Bounds, size: number, format: string, style = 'normal') {
  return (
    'https://data.geopf.fr/wms-r?' +
    new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetMap',
      LAYERS: layer,
      FORMAT: format,
      STYLES: style,
      CRS: 'EPSG:3857',
      BBOX: b.join(','),
      WIDTH: String(size),
      HEIGHT: String(size),
      TRANSPARENT: 'TRUE',
    })
  );
}
async function pixels(buffer: ArrayBuffer, size: number) {
  const bitmap = await createImageBitmap(new Blob([buffer]));
  const c = new OffscreenCanvas(size, size),
    g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  return g.getImageData(0, 0, size, size);
}
async function png(data: ImageData) {
  const c = new OffscreenCanvas(data.width, data.height);
  c.getContext('2d')!.putImageData(data, 0, 0);
  return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
}
async function terrain(z: number, x: number, y: number, signal: AbortSignal) {
  const b = tileBounds(z, x, y),
    size = 256;
  let values: Float32Array | undefined;
  let source = 'RGE ALTI';
  if (z >= 13) {
    try {
      const raw = await fetchBuffer(
        wms('IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G', b, size, 'image/geotiff'),
        signal,
      );
      const tiff = await fromArrayBuffer(raw);
      const im = await tiff.getImage();
      const raster = await im.readRasters({ samples: [0], interleave: true });
      values = new Float32Array(raster as any);
      source = 'LiDAR HD / RGE ALTI';
    } catch (error) {
      signal.throwIfAborted();
    }
  }
  let fallback: ImageData | undefined;
  const valid = (v: number) => Number.isFinite(v) && v > -500 && v < 10000;
  if (!values || values.some((v) => !valid(v)))
    fallback = await pixels(
      await fetchBuffer(
        wms('ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES', b, size, 'image/png', 'terrainrgb'),
        signal,
      ),
      size,
    );
  const elevations = new Float32Array(size * size);
  const rgba = new Uint8ClampedArray(size * size * 4);
  let min = Infinity,
    max = -Infinity,
    missing = 0;
  for (let i = 0; i < size * size; i++) {
    let elevation = values?.[i];
    if (elevation === undefined || !valid(elevation)) {
      const p = fallback?.data;
      elevation = p ? (p[i * 4] * 65536 + p[i * 4 + 1] * 256 + p[i * 4 + 2]) * 0.1 - 10000 : NaN;
    }
    if (!valid(elevation)) {
      elevation = 0;
      missing++;
    }
    elevations[i] = elevation;
    min = Math.min(min, elevation);
    max = Math.max(max, elevation);
    const v = Math.round((elevation + 10000) * 10);
    rgba.set([Math.floor(v / 65536), Math.floor(v / 256) % 256, v % 256, 255], i * 4);
  }
  return {
    buffer: await png(new ImageData(rgba, size, size)),
    elevations,
    min,
    max,
    missing,
    source,
  };
}
const coverage = new Map<
  string,
  { classes: Uint8Array; buffer: ArrayBuffer; source: string; known: number }
>();
async function cover(z: number, x: number, y: number, signal: AbortSignal) {
  const key = `${z}/${x}/${y}`,
    cached = coverage.get(key);
  if (cached) return { ...cached, buffer: cached.buffer.slice(0), classes: cached.classes.slice() };
  const size = 512,
    classes = new Uint8Array(size * size),
    b = tileBounds(z, x, y);
  let source = '',
    known = 0,
    failures = 0;
  for (const layer of ['IGNF_COSIA_2024-2026', 'IGNF_COSIA_2021-2023', 'IGNF_COSIA_2017-2020']) {
    try {
      const image = await pixels(await fetchBuffer(wms(layer, b, size, 'image/png'), signal), size);
      let added = 0;
      for (let i = 0; i < classes.length; i++) {
        if (classes[i]) continue;
        const value = classify(
          image.data[i * 4],
          image.data[i * 4 + 1],
          image.data[i * 4 + 2],
          image.data[i * 4 + 3],
        );
        if (value) {
          classes[i] = value;
          added++;
        }
      }
      if (added) {
        source += (source ? ' + ' : '') + layer.replace('IGNF_', '');
        known += added;
      }
      if (known / classes.length > 0.99) break;
    } catch (error) {
      signal.throwIfAborted();
      failures++;
    }
  }
  if (failures === 3) throw Error('CoSIA indisponible');
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    if (c) rgba.set([...palette[c - 1], 255], i * 4);
  }
  const result = {
    classes,
    buffer: await png(new ImageData(rgba, size, size)),
    source: source || 'CoSIA absent',
    known,
  };
  coverage.set(key, result);
  while (coverage.size > 32) coverage.delete(coverage.keys().next().value!);
  return { ...result, buffer: result.buffer.slice(0), classes: classes.slice() };
}
ctx.onmessage = async (event) => {
  const m = event.data;
  if (m.type === 'cancel') {
    controllers.get(m.id)?.abort();
    return;
  }
  const control = new AbortController();
  controllers.set(m.id, control);
  try {
    const result =
      m.type === 'dem'
        ? await terrain(m.z, m.x, m.y, control.signal)
        : await cover(m.z, m.x, m.y, control.signal);
    const transfer: Transferable[] = [result.buffer];
    if ('classes' in result) transfer.push(result.classes.buffer);
    if ('elevations' in result) transfer.push(result.elevations.buffer);
    ctx.postMessage({ id: m.id, result }, transfer);
  } catch (error) {
    ctx.postMessage({ id: m.id, error: String(error), aborted: control.signal.aborted });
  } finally {
    controllers.delete(m.id);
  }
};
