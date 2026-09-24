import { persistentCache } from './persistent-cache';
import type { Feature, FeatureCollection } from 'geojson';
import { fetchJson } from './network';
import { boxGeometry, boundsOf, type Area, type Bounds, normalize, safeUrl, empty } from './geo';
export interface Commune {
  code: string;
  name: string;
  department: string;
  population: number | null;
  areaHa: number;
  townHall: [number, number];
  center: [number, number];
  postcodes: string[];
}
export interface Territory extends Commune {
  boundary: Area;
  bounds: Bounds;
}
export const SOURCE = {
  wfs: 'https://data.geopf.fr/wfs',
  gpu: 'https://apicarto.ign.fr/api/gpu',
  officialGpu: 'https://www.geoportail-urbanisme.gouv.fr/',
  ddt: 'https://carto2.geo-ide.din.developpement-durable.gouv.fr/rest-api/qgis/d8de8132-4e9f-4a0a-b3d5-cf9d980c321c',
};
export async function getCatalogue(): Promise<Commune[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}communes.json`);
  if (!response.ok) throw Error('Catalogue indisponible');
  const data = await response.json();
  return data.rows
    .map((r: any[]) => ({
      code: r[0],
      name: r[1],
      department: r[2],
      population: r[3],
      areaHa: r[4],
      townHall: r[5] ?? r[6],
      center: r[6] ?? r[5],
      postcodes: r[7],
    }))
    .filter((c: Commune) => c.center && c.townHall);
}
export function findCommunes(catalogue: Commune[], query: string): Commune[] {
  const q = normalize(query);
  if (!q) return [];
  return catalogue
    .filter(
      (c) =>
        normalize(c.name).includes(q) || c.code === q || c.postcodes.some((p) => p.startsWith(q)),
    )
    .sort(
      (a, b) =>
        Number(normalize(b.name) === q) - Number(normalize(a.name) === q) ||
        Number(normalize(b.name).startsWith(q)) - Number(normalize(a.name).startsWith(q)) ||
        (b.population ?? 0) - (a.population ?? 0),
    )
    .slice(0, 15);
}
export async function getTerritory(commune: Commune, signal: AbortSignal): Promise<Territory> {
  const data = await persistentCache.remember(
    `boundary/${commune.code}`,
    async () => {
      const value = await fetchJson(
        `https://geo.api.gouv.fr/communes/${commune.code}?fields=nom,code,contour,mairie,centre&format=json&geometry=contour`,
        signal,
      );
      if (!['Polygon', 'MultiPolygon'].includes(value.contour?.type))
        throw Error('Contour communal indisponible');
      return value;
    },
    (value) => JSON.stringify(value).length * 2,
    signal,
  );
  if (!['Polygon', 'MultiPolygon'].includes(data.contour?.type))
    throw Error('Contour communal indisponible');
  return { ...commune, boundary: data.contour, bounds: boundsOf(data.contour) };
}
export function wfsUrl(
  layer: string,
  bounds?: Bounds,
  offset = 0,
  count = 1000,
  filter?: string,
): string {
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: layer,
    OUTPUTFORMAT: 'application/json',
    SRSNAME: 'EPSG:4326',
    COUNT: String(count),
    STARTINDEX: String(offset),
  });
  if (bounds) params.set('BBOX', `${bounds.join(',')},urn:ogc:def:crs:OGC:1.3:CRS84`);
  if (filter) params.set('CQL_FILTER', filter);
  return `${SOURCE.wfs}?${params}`;
}
export async function wfs(
  layer: string,
  bounds: Bounds | undefined,
  signal: AbortSignal,
  filter?: string,
  limit = 16000,
): Promise<FeatureCollection> {
  const features: Feature[] = [];
  let total = Infinity;
  while (features.length < total) {
    const data = await fetchJson(wfsUrl(layer, bounds, features.length, 1000, filter), signal);
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features))
      throw Error('Réponse IGN invalide');
    const count = Number(data.numberMatched ?? data.totalFeatures);
    if (Number.isFinite(count)) total = count;
    if (!data.features.length) {
      if (features.length < total && total !== Infinity) throw Error('Réponse IGN incomplète');
      break;
    }
    features.push(...data.features);
    if (features.length >= limit && features.length < total)
      throw Error('Secteur trop dense : rapprochez la vue.');
    if (total === Infinity && data.features.length < 1000) break;
  }
  return { type: 'FeatureCollection', features };
}
export function normalizeBuildings(data: FeatureCollection): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: data.features
      .filter((f) => ['Polygon', 'MultiPolygon'].includes(f.geometry.type))
      .map((f) => {
        const p = f.properties ?? {},
          height = Number(p.hauteur);
        return {
          ...f,
          id: p.cleabs ?? f.id,
          properties: {
            id: p.cleabs ?? String(f.id),
            height: Number.isFinite(height) && height > 0 ? height : 0,
            heightKnown: Number.isFinite(height) && height > 0,
            nature: p.nature ?? '',
            usage: p.usage_1 ?? '',
            levels: p.nombre_d_etages,
            groundMin: p.altitude_minimale_sol,
            groundMax: p.altitude_maximale_sol,
            roofMin: p.altitude_minimale_toit,
            roofMax: p.altitude_maximale_toit,
          },
        };
      }),
  };
}
export async function parcelSearch(
  territory: Territory,
  query: string,
  signal: AbortSignal,
): Promise<FeatureCollection> {
  const m = normalize(query).match(/^(?:([0-9]?[a-z]{1,2})\s*)?(\d{1,4})$/);
  if (!m) return empty();
  const subdivisions: Record<string, [number, number]> = {
    '75056': [75101, 20],
    '69123': [69381, 9],
    '13055': [13201, 16],
  };
  const subdivision = subdivisions[territory.code];
  const codeFilter = subdivision
    ? `code_insee IN (${Array.from({ length: subdivision[1] }, (_, i) => `'${subdivision[0] + i}'`).join(',')},'${territory.code}')`
    : `code_insee='${territory.code}'`;
  const field =
    `${codeFilter} AND numero='${m[2].padStart(4, '0')}'` +
    (m[1] ? ` AND section='${m[1].toUpperCase().padStart(2, '0')}'` : '');
  return wfs('CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle', undefined, signal, field, 3000);
}
export interface Urbanism {
  collection: FeatureCollection;
  source: string;
  fetchedAt: number;
  status: 'available' | 'empty';
}
export function normalizeZones(data: FeatureCollection, kind: string, source: string): Feature[] {
  return data.features
    .filter((f) => ['Polygon', 'MultiPolygon'].includes(f.geometry.type))
    .map((f, i) => {
      const p = f.properties ?? {},
        code = String(p.libelle ?? p.LIBELLE ?? 'Sans code');
      return {
        ...f,
        id: `${source}:${kind}:${p.gid ?? f.id ?? i}`,
        properties: {
          id: `${source}:${kind}:${p.gid ?? f.id ?? i}`,
          code,
          description: p.libelong ?? '',
          kind,
          family:
            kind === 'Carte communale'
              ? 'CC'
              : /^\d?AU/i.test(code)
                ? 'AU'
                : /^[UAN]/i.test(code)
                  ? code[0].toUpperCase()
                  : 'Autre',
          date: String(p.datappro ?? p.DATAPPRO ?? p.datvalid ?? ''),
          dateLabel: p.datappro || p.DATAPPRO ? 'Approbation' : 'Version du document',
          url:
            safeUrl(p.urlfic ?? p.URLFIC) ||
            (p.gpu_doc_id && p.nomfic
              ? `${SOURCE.officialGpu}api/document/${encodeURIComponent(p.gpu_doc_id)}/files/${encodeURIComponent(p.nomfic)}`
              : ''),
          documentUrl: p.gpu_doc_id
            ? `${SOURCE.officialGpu}document/by-id/${encodeURIComponent(p.gpu_doc_id)}`
            : '',
          document: p.idurba ?? p.partition ?? '',
          source,
        },
      };
    });
}
async function gpuLayer(
  layer: string,
  bounds: Bounds,
  signal: AbortSignal,
  depth = 0,
): Promise<FeatureCollection> {
  const url = `${SOURCE.gpu}/${layer}?${new URLSearchParams({ geom: JSON.stringify(boxGeometry(bounds)) })}`;
  const data = await fetchJson(url, signal);
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features))
    throw Error('Réponse urbanisme invalide');
  const total = Number(data.numberMatched ?? data.totalFeatures);
  if (Number.isFinite(total) && total > data.features.length) {
    if (depth >= 5) throw Error('Zonage trop dense pour cette vue');
    const [w, s, e, n] = bounds,
      m = (w + e) / 2,
      k = (s + n) / 2;
    const output: Feature[] = [];
    for (const b of [
      [w, s, m, k],
      [m, s, e, k],
      [w, k, m, n],
      [m, k, e, n],
    ] as Bounds[])
      output.push(...(await gpuLayer(layer, b, signal, depth + 1)).features);
    return {
      type: 'FeatureCollection',
      features: [...new Map(output.map((f) => [f.id ?? f.properties?.gid, f])).values()],
    };
  }
  return data;
}
export async function getUrbanism(
  territory: Territory,
  bounds: Bounds,
  signal: AbortSignal,
): Promise<Urbanism> {
  const [plu, cc] = await Promise.all([
    gpuLayer('zone-urba', bounds, signal),
    gpuLayer('secteur-cc', bounds, signal),
  ]);
  let features = [
    ...normalizeZones(plu, 'PLU / PLUi', 'Géoportail de l’urbanisme'),
    ...normalizeZones(cc, 'Carte communale', 'Géoportail de l’urbanisme'),
  ];
  let source = 'Géoportail de l’urbanisme';
  // Some Ariège documents are not present on GPU. Keep the official regional publication as a fallback.
  if (!features.length && territory.department === '09') {
    const results = await Promise.all(
      ['ZONES_DES_PLU', 'SECTEURS_DES_CARTES_COMMUNALES'].map(async (name) => {
        const filter = `<Filter xmlns="http://www.opengis.net/ogc"><PropertyIsEqualTo><PropertyName>INSEE</PropertyName><Literal>${territory.code}</Literal></PropertyIsEqualTo></Filter>`;
        const params = new URLSearchParams({
          SERVICE: 'WFS',
          VERSION: '1.1.0',
          REQUEST: 'GetFeature',
          TYPENAME: name,
          OUTPUTFORMAT: 'application/json',
          SRSNAME: 'EPSG:4326',
          MAXFEATURES: '10000',
          FILTER: filter,
        });
        const data = await fetchJson(`${SOURCE.ddt}?${params}`, signal);
        if (data.type !== 'FeatureCollection' || data.features.length >= 10000)
          throw Error('Réponse DDT incomplète');
        return data as FeatureCollection;
      }),
    );
    features = [
      ...normalizeZones(results[0], 'PLU / PLUi', 'DDT de l’Ariège'),
      ...normalizeZones(results[1], 'Carte communale', 'DDT de l’Ariège'),
    ];
    source = 'DDT de l’Ariège';
  }
  return {
    collection: { type: 'FeatureCollection', features },
    source,
    fetchedAt: Date.now(),
    status: features.length ? 'available' : 'empty',
  };
}
