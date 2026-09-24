import * as maplibregl from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
maplibregl.setWorkerUrl(mapWorkerUrl);
maplibregl.setWorkerCount(2);
import type { GeoJSONSource, Map as GLMap } from 'maplibre-gl';
import type { FeatureCollection, Feature } from 'geojson';
import {
  getCatalogue,
  findCommunes,
  getTerritory,
  wfs,
  normalizeBuildings,
  parcelSearch,
  getUrbanism,
  type Commune,
  type Territory,
} from './services';
import {
  empty,
  contains,
  lngLat,
  boundsOf,
  boxGeometry,
  escapeHtml as esc,
  type Bounds,
  type Area,
  geometryCenter,
} from './geo';
import { registerRasters, coverForBounds, groundForBounds, rasterStats } from './rasters';
import { makeStyle } from './map-style';
import { Details } from './details';
import { SectorCache, surroundingSectors, ownedFeatures, type Sector } from './sector-cache';
import { ModelPool } from './model-pool';
import { clip, type ModelResult } from './model';
import { network as networkStats, fetchJson } from './network';
import { persistentCache, clearPersistentData } from './persistent-cache';
import './style.css';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
document.querySelector('#app')!.innerHTML = `
 <div id="map" aria-label="Carte 3D interactive"></div>
 <aside class="sidebar panel" id="sidebar"><div class="brand"><span class="mark" aria-hidden="true">⌁</span><div><h1>Communes</h1><p>La France en relief</p></div><button class="mobile-toggle" id="collapse" aria-label="Réduire les outils">−</button></div>
 <label class="field commune-field" for="commune">Explorer une commune</label><div class="input-wrap"><input id="commune" type="search" placeholder="Commune ou code postal…" autocomplete="off" aria-controls="commune-results"><div class="results" id="commune-results" aria-live="polite"></div></div>
 <p id="meta" class="meta">Le territoire français, à portée de vue.</p>
 <div class="extras"><label class="field" for="search">Un lieu dans la commune</label><div class="input-wrap"><input id="search" type="search" placeholder="Hameau, rue ou parcelle AB 123…" autocomplete="off" aria-controls="search-results"><div class="results" id="search-results" aria-live="polite"></div></div>
 <div class="layers"><label class="toggle"><span><i class="dot green"></i>Bâtiments et arbres en 3D</span><input id="details" type="checkbox" checked></label><label class="toggle"><span><i class="dot"></i>Parcelles cadastrales</span><input id="parcels" type="checkbox"></label><label class="toggle"><span><i class="dot purple"></i>Urbanisme · PLU / PLUi</span><input id="urbanism" type="checkbox"></label><label class="toggle"><span>Photographie aérienne</span><input id="ortho" type="checkbox"></label></div>
 <div id="legend" class="legend" hidden><span style="--c:#ca737c">U</span><span style="--c:#e7ad65">AU</span><span style="--c:#ead782">A</span><span style="--c:#81b08b">N</span></div>
 <div class="actions"><button id="extent">Toute la commune</button><button id="center">Le centre</button><button id="help-button" aria-label="Aide et sources">?</button></div><div id="status" class="status" role="status" aria-live="polite"></div></div></aside>
 <aside class="help panel" id="help" hidden><h2>Explorer le territoire</h2><p>Faites glisser pour vous déplacer. Utilisez la molette ou deux doigts pour zoomer. Pour tourner et incliner : clic droit + glisser, ou Ctrl + glisser. La boussole rétablit le nord.</p><p>Les détails arrivent autour de la vue. Rapprochez-vous pour voir les arbres et les toitures. Sur mobile, utilisez deux doigts pour tourner et incliner.</p><p>Les emprises et hauteurs viennent de l’IGN. Les toitures, fenêtres et arbres sont des représentations indicatives, pas un relevé architectural. Les hauteurs absentes ne sont pas inventées.</p><p>Les zones d’urbanisme sont récupérées à la consultation. Cliquez sur une zone pour accéder au document officiel. Une zone absente du service ne signifie pas qu’elle est sans règles.</p><p><a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN · BD TOPO, CoSIA, RGE ALTI / LiDAR HD</a><br><a href="https://www.geoportail-urbanisme.gouv.fr/" target="_blank" rel="noopener">Géoportail de l’urbanisme</a> · <a href="https://geo.api.gouv.fr/" target="_blank" rel="noopener">API Découpage administratif</a></p><p>Les secteurs visités sont conservés dans ce navigateur pendant sept jours, dans la limite de 256 Mo (80 Mo sur mobile). Le bouton « Effacer les données » supprime cette sauvegarde ; la carte ouverte reste utilisable et la sauvegarde reprend au prochain chargement. Le PLU est consulté en direct. Aucune donnée de terrain n’est hébergée ici. Les données transitent directement des services publics vers votre navigateur. Licence Ouverte pour les données IGN ouvertes.</p></aside>
 <aside class="info panel" id="info" hidden></aside><div class="footer" id="caption">Relief réel · données publiques · exploration progressive</div>
 <div id="cache-feedback" class="cache-feedback" role="status" aria-live="polite"></div><div id="loading" class="loading"><strong>La France, en relief.</strong><small id="boot-status">Chargement du catalogue des communes…</small></div>`;
const statuses = new Map<string, { text: string; error?: boolean; pending?: boolean }>();
function status(key: string, text: string, error = false, pending = false) {
  statuses.set(key, { text, error, pending });
  $('status').innerHTML = [...statuses.values()]
    .map((s) => `<p class="${s.error ? 'error' : s.pending ? 'pending' : ''}">${esc(s.text)}</p>`)
    .join('');
}
const checked = (id: string) => $<HTMLInputElement>(id).checked;
let map: GLMap,
  details: Details,
  catalogue: Commune[] = [],
  territory: Territory | null = null,
  scope = new AbortController(),
  zoneController = new AbortController(),
  searchController = new AbortController();
let scopeId = 0,
  sectorView = 0,
  parcelView = 0,
  refreshTimer: ReturnType<typeof setTimeout>,
  searchTimer: ReturnType<typeof setTimeout>,
  zoneTimer: ReturnType<typeof setTimeout>;
let currentBuildings = empty(),
  currentZones = empty(),
  currentParcels = empty(),
  modelData: ModelResult | null = null;
let lastSector = '',
  lastZones = '',
  lastParcels = '';
const diagnostics: any = {
  ready: false,
  commune: null,
  phase: 'startup',
  errors: [],
  selections: 0,
  terrain: null,
  urbanism: null,
  parcels: null,
  model: null,
  buildingCount: 0,
  timings: {},
};
const mobileDevice = matchMedia('(max-width:650px)').matches;
const modelPool = new ModelPool();
interface StoredSector {
  tile: Sector;
  buildings: FeatureCollection;
  model: ModelResult;
  terrain: { min: number; max: number };
  cover: string;
}
let activeSectorKeys = new Set<string>(),
  activeParcelKeys = new Set<string>();
const tileModels = new SectorCache<StoredSector>(
  (mobileDevice ? 80 : 256) * 1024 ** 2,
  mobileDevice ? 16 : 36,
  (key) => details?.remove(key),
);
const tileParcels = new SectorCache<FeatureCollection>(
  (mobileDevice ? 12 : 40) * 1024 ** 2,
  mobileDevice ? 24 : 72,
);
const vectorState = { buildings: new Map<string, Feature>(), parcels: new Map<string, Feature>() };
let vectorQueue = Promise.resolve();
const workQueue: { run: () => void; signal: AbortSignal; reject: (e: unknown) => void }[] = [];
let working = 0;
function pumpWork() {
  while (working < 2 && workQueue.length) {
    const job = workQueue.shift()!;
    if (job.signal.aborted) {
      job.reject(job.signal.reason);
      continue;
    }
    working++;
    job.run();
  }
}
async function boundedWork<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    workQueue.push({ run: resolve, reject, signal });
    pumpWork();
  });
  try {
    signal.throwIfAborted();
    return await fn();
  } finally {
    working--;
    pumpWork();
  }
}
function syncVector(id: 'buildings' | 'parcels', features: Feature[]) {
  const previous = vectorState[id],
    next = new Map(features.map((f) => [String(f.id), f]));
  const add = features.filter((f) => previous.get(String(f.id)) !== f),
    remove = [...previous.keys()].filter((key) => !next.has(key));
  vectorState[id] = next;
  if (!add.length && !remove.length) return;
  const version = scopeId;
  vectorQueue = vectorQueue
    .catch(() => {})
    .then(async () => {
      if (version !== scopeId) return;
      await (map.getSource(id) as GeoJSONSource).updateData({ add, remove });
    })
    .catch((e) => {
      if (version === scopeId) diagnostics.errors.push(String(e));
    });
}
function cacheDiagnostics() {
  diagnostics.cache = {
    models: tileModels.snapshot(),
    parcels: tileParcels.snapshot(),
    builds: modelPool.stats.builds,
    workerStarts: modelPool.stats.workerStarts,
    gpuAllocations: details.allocations,
    gpuRemovals: details.removals,
    visibleChunks: [...activeSectorKeys].filter((k) => tileModels.has(k)).length,
  };
}
function publishModels() {
  if (!territory) return;
  const all = tileModels.values(),
    active = all.filter((v) => activeSectorKeys.has(v.tile.key));
  const features = [
    ...new Map(all.flatMap((v) => v.buildings.features).map((f) => [String(f.id), f])).values(),
  ];
  currentBuildings = { type: 'FeatureCollection', features };
  const ids = new Set(all.flatMap((v) => v.model.ids));
  syncVector(
    'buildings',
    features.filter((f) => !ids.has(String(f.properties?.id))),
  );
  const trees = active.flatMap((v) => v.model.trees),
    models = active.map((v) => v.model),
    stats = {
      buildings: models.reduce((n, m) => n + m.stats.buildings, 0),
      roofs: models.reduce((n, m) => n + m.stats.roofs, 0),
      windows: models.reduce((n, m) => n + m.stats.windows, 0),
      trees: trees.length,
      treeCandidates: models.reduce((n, m) => n + m.stats.treeCandidates, 0),
      triangles: models.reduce((n, m) => n + m.stats.triangles, 0),
      minHeight: Math.min(...models.map((m) => m.stats.minHeight), Infinity),
      maxHeight: Math.max(...models.map((m) => m.stats.maxHeight), 0),
      finite: models.every((m) => m.stats.finite),
      treeSources: [...new Set(models.flatMap((m) => m.stats.treeSources))],
    };
  modelData = active.length
    ? {
        positions: new Float32Array(),
        colors: new Float32Array(),
        trees,
        ids: models.flatMap((m) => m.ids),
        spans: [],
        stats,
      }
    : null;
  const visibleBuildings = active.flatMap((v) => v.buildings.features);
  diagnostics.buildingCount = visibleBuildings.length;
  diagnostics.model = modelData
    ? {
        ...stats,
        sourceHeights: visibleBuildings
          .map((f) => f.properties?.height)
          .filter((h) => h > 0)
          .slice(0, 20),
        outsideBuildings: visibleBuildings.filter(
          (f) => !contains(geometryCenter(f.geometry as Area), territory!.boundary),
        ).length,
        outsideTrees: trees.filter((t) => !contains([t.lon, t.lat], territory!.boundary)).length,
      }
    : null;
  if (active.length) {
    diagnostics.terrain = {
      min: Math.min(...active.map((v) => v.terrain.min)),
      max: Math.max(...active.map((v) => v.terrain.max)),
    };
    if (checked('details') && map.getZoom() >= 14)
      status(
        'model',
        `${visibleBuildings.length.toLocaleString('fr-FR')} bâtiments · ${trees.length.toLocaleString('fr-FR')} arbres`,
      );
    status(
      'cover',
      active.some((v) => v.cover === 'CoSIA')
        ? 'Boisements CoSIA · arbres indicatifs'
        : 'Boisements BD TOPO · arbres indicatifs',
    );
  }
  cacheDiagnostics();
}
function publishParcels() {
  currentParcels = {
    type: 'FeatureCollection',
    features: [
      ...new Map(
        tileParcels
          .values()
          .flatMap((c) => c.features)
          .map((f) => [String(f.id), f]),
      ).values(),
    ],
  };
  syncVector('parcels', currentParcels.features);
  diagnostics.parcels = {
    count: currentParcels.features.length,
    sample: currentParcels.features[0]?.properties,
  };
  if (checked('parcels'))
    status(
      'parcels',
      `${currentParcels.features.length.toLocaleString('fr-FR')} parcelles conservées`,
    );
  cacheDiagnostics();
}
function data(id: string, collection: FeatureCollection) {
  (map.getSource(id) as GeoJSONSource)?.setData(collection);
}
function visible(id: string, on: boolean) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
function showInfo(title: string, body: string, tag = '') {
  const el = $('info');
  el.innerHTML = `<button class="close" id="close-info" aria-label="Fermer">×</button><div class="tag">${esc(tag)}</div><h2>${esc(title)}</h2>${body}`;
  el.hidden = false;
  $('close-info').onclick = () => {
    el.hidden = true;
    data('selection', empty());
  };
}
function fit(g: Area) {
  const b = boundsOf(g);
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    {
      padding: matchMedia('(max-width:650px)').matches
        ? 60
        : { left: 400, right: 80, top: 80, bottom: 80 },
      maxZoom: 18,
      duration: 1000,
      pitch: 45,
    },
  );
}
function updateMask(t: Territory) {
  const world = boxGeometry([-180, -85, 180, 85]);
  const coordinates =
    t.boundary.type === 'Polygon' ? [t.boundary.coordinates] : t.boundary.coordinates;
  data('boundary', {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: t.boundary, properties: { name: t.name } }],
  });
  data('mask', {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [world.coordinates[0], ...coordinates.map((poly) => poly[0])],
        },
      },
      ...coordinates.flatMap((poly) =>
        poly.slice(1).map((r) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: { type: 'Polygon' as const, coordinates: [r] },
        })),
      ),
    ],
  });
}
function viewBounds(): Bounds {
  const b = map.getBounds(),
    t = territory!;
  return [
    Math.max(b.getWest(), t.bounds[0]),
    Math.max(b.getSouth(), t.bounds[1]),
    Math.min(b.getEast(), t.bounds[2]),
    Math.min(b.getNorth(), t.bounds[3]),
  ];
}
const validBounds = (b: Bounds) => b[0] < b[2] && b[1] < b[3];
async function selectCommune(code: string) {
  const commune = catalogue.find((c) => c.code === code);
  if (!commune) throw Error('Commune inconnue');
  const id = ++scopeId,
    start = performance.now();
  scope.abort();
  zoneController.abort();
  searchController.abort();

  scope = new AbortController();
  territory = null;
  sectorView++;
  parcelView++;
  activeSectorKeys.clear();
  activeParcelKeys.clear();
  tileModels.clear();
  tileParcels.clear();
  vectorState.buildings.clear();
  vectorState.parcels.clear();
  lastSector = lastZones = lastParcels = '';
  details.clear();
  currentBuildings = empty();
  currentZones = empty();
  currentParcels = empty();
  modelData = null;
  for (const source of ['boundary', 'mask', 'buildings', 'zones', 'parcels', 'selection'])
    data(source, empty());
  statuses.clear();
  status('boundary', 'Limites administratives…', false, true);
  $('info').hidden = true;
  $('commune-results').innerHTML = '';
  $('search-results').innerHTML = '';
  $<HTMLInputElement>('commune').value = commune.name;
  $<HTMLInputElement>('search').value = '';
  $('meta').textContent =
    `${commune.department} · ${(commune.population ?? 0).toLocaleString('fr-FR')} habitants · ${(commune.areaHa / 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km²`;
  Object.assign(diagnostics, {
    phase: 'boundary',
    commune: code,
    model: null,
    urbanism: null,
    parcels: null,
    buildingCount: 0,
    timings: {},
  });
  diagnostics.selections++;
  try {
    const t = await getTerritory(commune, scope.signal);
    if (id !== scopeId) return;
    territory = t;
    updateMask(t);
    const url = new URL(location.href);
    url.searchParams.set('commune', code);
    history.replaceState({}, '', url);
    status('boundary', `${t.name} · limites officielles`);
    diagnostics.boundary = {
      type: t.boundary.type,
      bounds: t.bounds,
      townHallInside: contains(t.townHall, t.boundary),
    };
    diagnostics.timings.boundaryMs = performance.now() - start;
    map.jumpTo({ center: t.townHall, zoom: 15.6, pitch: 50, bearing: -18 });
    diagnostics.phase = 'loading';
    await Promise.allSettled([
      refreshSector(true),
      refreshUrbanism(true),
      checked('parcels') ? refreshParcels(true) : Promise.resolve(),
    ]);
    if (id === scopeId) {
      diagnostics.phase = [...activeSectorKeys].every((k) => tileModels.has(k))
        ? 'ready'
        : diagnostics.phase;
      diagnostics.timings.completeMs = performance.now() - start;
    }
  } catch (error) {
    if (id === scopeId && !scope.signal.aborted) {
      diagnostics.phase = 'error';
      status('boundary', `Limites indisponibles : ${String(error)}`, true);
    }
  }
}
async function refreshSector(_force = false) {
  if (!territory || !map.getSource('buildings') || !checked('details')) return;
  if (map.getZoom() < 14) {
    sectorView++;
    lastSector = '';
    activeSectorKeys.clear();
    details.activate([]);
    status('model', 'Rapprochez-vous pour afficher les détails 3D.');
    cacheDiagnostics();
    return;
  }
  const t = territory,
    id = scopeId,
    tiles = surroundingSectors(map.getCenter().toArray(), t.bounds),
    key = tiles
      .map((t) => t.key)
      .sort()
      .join('|'),
    version = ++sectorView,
    start = performance.now(),
    signal = scope.signal;
  if (tiles.length && key === lastSector && tiles.every((t) => tileModels.has(t.key))) {
    status(
      'model',
      `${diagnostics.buildingCount.toLocaleString('fr-FR')} bâtiments · ${(diagnostics.model?.trees ?? 0).toLocaleString('fr-FR')} arbres`,
    );
    diagnostics.phase = 'ready';
    diagnostics.timings.modelMs = performance.now() - start;
    cacheDiagnostics();
    return;
  }
  activeSectorKeys = new Set(tiles.map((t) => t.key));
  tileModels.protect(activeSectorKeys);
  details.activate(activeSectorKeys);
  // Restore retained GPU objects synchronously, including an immediate return to a visited area.
  for (const tile of tiles) {
    const saved = tileModels.peek(tile.key);
    if (saved) details.update(tile.key, saved.model, tile.origin);
  }
  publishModels();
  diagnostics.phase = tiles.every((t) => tileModels.has(t.key)) ? 'ready' : 'loading';
  if (tiles.length && diagnostics.phase === 'ready') {
    lastSector = key;
    for (const tile of tiles) tileModels.touch(tile.key);
    diagnostics.timings.modelMs = performance.now() - start;
    cacheDiagnostics();
    return;
  }
  lastSector = key;
  if (!tiles.length) {
    status('model', 'Revenez dans la commune pour explorer ses détails.');
    return;
  }
  try {
    for (const tile of tiles) {
      if (version !== sectorView || signal.aborted) return;
      const entry = await tileModels.get(
        tile.key,
        () =>
          persistentCache.remember(
            `model/${t.code}/${mobileDevice ? 'mobile' : 'desktop'}/${tile.key}`,
            () =>
              boundedWork(async () => {
                signal.throwIfAborted();
                if (!activeSectorKeys.has(tile.key))
                  throw new DOMException('Secteur hors de la vue', 'AbortError');
                const padding = 25,
                  b: Bounds = [
                    tile.projected[0] - padding,
                    tile.projected[1] - padding,
                    tile.projected[2] + padding,
                    tile.projected[3] + padding,
                  ];
                const [raw, covers, ground] = await Promise.all([
                  wfs(
                    'BDTOPO_V3:batiment',
                    [...lngLat(b[0], b[1]), ...lngLat(b[2], b[3])] as Bounds,
                    signal,
                  ),
                  coverForBounds(b, signal).catch(() => {
                    signal.throwIfAborted();
                    return [];
                  }),
                  groundForBounds(tile.projected, signal),
                ]);
                const obstacles = normalizeBuildings(raw),
                  buildings = ownedFeatures(obstacles, tile);
                const needsForest =
                  !covers.length || covers.some((c) => c.known / c.classes.length < 0.9);
                const forests = needsForest
                  ? await wfs('BDTOPO_V3:zone_de_vegetation', tile.geographic, signal).catch(() => {
                      signal.throwIfAborted();
                      return empty();
                    })
                  : empty();
                forests.features = forests.features.filter((f) =>
                  /bois|forêt|foret|peupleraie|mangrove/i.test(String(f.properties?.nature ?? '')),
                );
                const result = await modelPool.run(
                  {
                    buildings,
                    obstacles,
                    boundary: t.boundary,
                    origin: tile.origin,
                    bounds: tile.projected,
                    covers,
                    ground,
                    forests,
                    limit: mobileDevice ? 220 : 600,
                    treeLimit: mobileDevice ? 330 : 900,
                    maxVertices: mobileDevice ? 100000 : 350000,
                  },
                  signal,
                );
                signal.throwIfAborted();
                return {
                  tile,
                  buildings: result.buildings,
                  model: result.model,
                  terrain: { min: Math.min(...ground.values), max: Math.max(...ground.values) },
                  cover: covers.some((c) => c.known) ? 'CoSIA' : 'BD TOPO',
                };
              }, signal),
            (entry) =>
              entry.model.positions.byteLength +
              entry.model.colors.byteLength +
              JSON.stringify({
                buildings: entry.buildings,
                trees: entry.model.trees,
                spans: entry.model.spans,
              }).length *
                2,
            signal,
          ),
        (entry) =>
          entry.model.positions.byteLength * 6 +
          entry.model.trees.length * 700 +
          JSON.stringify(entry.buildings).length * 2,
      );
      signal.throwIfAborted();
      if (id !== scopeId) return;
      if (tileModels.has(tile.key) && activeSectorKeys.has(tile.key))
        details.update(tile.key, entry.model, tile.origin);
      publishModels();
      if (version !== sectorView) return;
      if (!diagnostics.timings.firstBuildingsMs)
        diagnostics.timings.firstBuildingsMs = performance.now() - start;
    }
    if (version !== sectorView) return;
    diagnostics.timings.modelMs = performance.now() - start;
    diagnostics.phase = 'ready';
    $('caption').textContent = `${t.name} · détails conservés pendant la navigation · relief 1:1`;
  } catch (error) {
    if (!signal.aborted && id === scopeId && version === sectorView) {
      lastSector = '';
      diagnostics.phase = 'partial';
      if ((error as Error).name !== 'AbortError') {
        diagnostics.errors.push(String(error));
        status(
          'model',
          `Certains détails sont indisponibles : ${String(error).replace(/^Error: /, '')}`,
          true,
        );
      }
    }
  }
  cacheDiagnostics();
}
async function refreshUrbanism(force = false) {
  if (!territory) return;
  const t = territory,
    id = scopeId,
    b = viewBounds();
  if (!validBounds(b)) return;
  const key = b.map((n) => n.toFixed(3)).join('/');
  if (!force && lastZones === key) return;
  lastZones = key;
  zoneController.abort();
  zoneController = new AbortController();
  const signal = zoneController.signal;
  status('zones', 'Urbanisme : consultation des services…', false, true);
  try {
    const result = await getUrbanism(t, b, signal);
    signal.throwIfAborted();
    if (id !== scopeId) return;
    currentZones = clip(result.collection, t.boundary);
    data('zones', currentZones);
    diagnostics.urbanism = {
      source: result.source,
      count: currentZones.features.length,
      status: result.status,
      codes: [...new Set(currentZones.features.map((f) => f.properties?.code))].slice(0, 12),
      links: currentZones.features.filter((f) => f.properties?.url).length,
    };
    status(
      'zones',
      currentZones.features.length
        ? `Urbanisme · ${currentZones.features.length} zones · ${result.source}`
        : 'Aucun zonage renvoyé ici · consulter le GPU',
    );
  } catch (error) {
    if (!signal.aborted && id === scopeId) {
      lastZones = '';
      diagnostics.urbanism = { status: 'error', error: String(error) };
      status('zones', 'Urbanisme temporairement indisponible', true);
    }
  }
}
async function refreshParcels(_force = false) {
  if (!territory || !checked('parcels')) return;
  if (map.getZoom() < 14) {
    parcelView++;
    status('parcels', 'Cadastre conservé · rapprochez-vous pour le détail.');
    return;
  }
  const t = territory,
    id = scopeId,
    tiles = surroundingSectors(map.getCenter().toArray(), t.bounds),
    version = ++parcelView,
    signal = scope.signal,
    key = tiles
      .map((t) => t.key)
      .sort()
      .join('|');
  activeParcelKeys = new Set(tiles.map((t) => t.key));
  tileParcels.protect(activeParcelKeys);
  if (tiles.every((t) => tileParcels.has(t.key))) {
    if (key !== lastParcels) for (const tile of tiles) tileParcels.touch(tile.key);
    lastParcels = key;
    status(
      'parcels',
      `${currentParcels.features.length.toLocaleString('fr-FR')} parcelles conservées`,
    );
    cacheDiagnostics();
    return;
  }
  lastParcels = key;
  try {
    for (const tile of tiles) {
      if (version !== parcelView || signal.aborted) return;
      await tileParcels.get(
        tile.key,
        () =>
          persistentCache.remember(
            `parcels/${t.code}/${tile.key}`,
            () =>
              boundedWork(async () => {
                signal.throwIfAborted();
                if (!activeParcelKeys.has(tile.key))
                  throw new DOMException('Secteur hors de la vue', 'AbortError');
                const raw = await wfs(
                    'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle',
                    tile.geographic,
                    signal,
                  ),
                  // Large rural parcels can extend beyond the loaded sectors: keep full intersecting
                  // footprints and deduplicate by cadastral ID when publishing the cache.
                  result = clip(raw, t.boundary);
                result.features = result.features.map((f) => ({
                  ...f,
                  id: String(f.properties?.idu ?? f.id ?? f.properties?.gid),
                  properties: {
                    ...f.properties,
                    parcelLabel:
                      f.properties?.numero == null || f.properties.numero === ''
                        ? ''
                        : String(f.properties.numero).padStart(4, '0'),
                  },
                }));
                return result;
              }, signal),
            (c) => JSON.stringify(c).length * 2,
            signal,
          ),
        (c) => JSON.stringify(c).length * 3,
      );
      signal.throwIfAborted();
      if (id !== scopeId) return;
      publishParcels();
    }
  } catch (error) {
    if (!signal.aborted && id === scopeId && version === parcelView) {
      lastParcels = '';
      if ((error as Error).name !== 'AbortError') {
        diagnostics.parcels = { error: String(error) };
        status('parcels', 'Certains secteurs du cadastre sont indisponibles', true);
      }
    }
  }
}
function displayZone(f: Feature) {
  const p = f.properties ?? {};
  data('selection', { type: 'FeatureCollection', features: [f] });
  showInfo(
    `Zone ${p.code}`,
    `<p>${esc(p.description || p.kind)}</p>${p.date ? `<p>${esc(p.dateLabel || 'Approbation')} : ${esc(/^\d{8}$/.test(p.date) ? `${p.date.slice(6, 8)}/${p.date.slice(4, 6)}/${p.date.slice(0, 4)}` : p.date)}</p>` : ''}${p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener">Consulter le règlement officiel ↗</a></p>` : ''}${p.documentUrl ? `<p><a href="${esc(p.documentUrl)}" target="_blank" rel="noopener">Voir le document et ses annexes ↗</a></p>` : ''}<p><a href="https://www.geoportail-urbanisme.gouv.fr/map/#tile=1&lon=${map.getCenter().lng}&lat=${map.getCenter().lat}&zoom=16" target="_blank" rel="noopener">Ouvrir le Géoportail de l’urbanisme ↗</a></p><small>${esc(p.source)} · données consultées aujourd’hui. Le règlement et les annexes officiels précisent les dispositions applicables.</small>`,
    p.kind,
  );
}
function displayParcel(f: Feature) {
  const p = f.properties ?? {};
  data('selection', { type: 'FeatureCollection', features: [f] });
  showInfo(
    `${p.section ?? ''} ${p.numero ?? ''}`,
    `<p>${esc(p.nom_com || territory?.name)}</p><p>Identifiant : ${esc(p.idu ?? f.id ?? '—')}</p>${p.contenance ? `<p>Contenance cadastrale : ${Number(p.contenance).toLocaleString('fr-FR')} m²</p>` : ''}<small>Parcellaire Express IGN. Le contour affiché ne constitue pas un bornage.</small>`,
    'Parcelle cadastrale',
  );
}
function setupEvents() {
  $('commune').addEventListener('input', () => {
    const q = $<HTMLInputElement>('commune').value,
      results = findCommunes(catalogue, q);
    $('commune-results').innerHTML =
      results
        .map(
          (c) =>
            `<button data-code="${c.code}">${esc(c.name)}<small>${esc(c.department)} · ${esc(c.postcodes.join(', '))} · ${(c.population ?? 0).toLocaleString('fr-FR')} hab.</small></button>`,
        )
        .join('') || (q ? '<button disabled>Aucune commune trouvée</button>' : '');
  });
  $('commune-results').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-code]');
    if (b) void selectCommune(b.dataset.code!);
  };
  $('commune').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const c = findCommunes(catalogue, $<HTMLInputElement>('commune').value)[0];
      if (c) void selectCommune(c.code);
    }
    if (e.key === 'Escape') $('commune-results').innerHTML = '';
  });
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchController.abort();
    $('search-results').innerHTML = '';
    searchTimer = setTimeout(() => void searchPlace(), 400);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      void searchPlace();
    }
    if (e.key === 'Escape') $('search-results').innerHTML = '';
  });
  $('details').onchange = () => {
    details.visible = checked('details');
    visible('buildings-3d', checked('details'));
    if (checked('details')) void refreshSector(true);
    else {
      sectorView++;
      status('model', 'Détails 3D masqués');
    }
    map.triggerRepaint();
  };
  $('parcels').onchange = () => {
    for (const id of ['parcels-fill', 'parcels-lines', 'parcels-labels'])
      visible(id, checked('parcels'));
    if (checked('parcels')) void refreshParcels(true);
    else {
      parcelView++;
      status('parcels', 'Parcelles masquées');
    }
  };
  $('urbanism').onchange = () => {
    for (const id of ['urbanism-fill', 'urbanism-lines', 'urbanism-labels'])
      visible(id, checked('urbanism'));
    $('legend').hidden = !checked('urbanism');
    if (checked('urbanism')) void refreshUrbanism();
  };
  $('ortho').onchange = () => visible('ortho', checked('ortho'));
  $('extent').onclick = () => {
    if (territory) fit(territory.boundary);
  };
  $('center').onclick = () => {
    if (territory) map.flyTo({ center: territory.townHall, zoom: 16, pitch: 50, duration: 1200 });
  };
  $('help-button').onclick = () => {
    $('help').hidden = !$('help').hidden;
  };
  $('collapse').onclick = () => {
    const collapsed = $('sidebar').classList.toggle('collapsed');
    $('collapse').textContent = collapsed ? '+' : '−';
  };
  if (matchMedia('(max-width:650px)').matches) {
    $('sidebar').classList.add('collapsed');
    $('collapse').textContent = '+';
  }
  map.on('moveend', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refreshSector();
      void refreshParcels();
    }, 350);
    clearTimeout(zoneTimer);
    zoneTimer = setTimeout(() => {
      if (checked('urbanism')) void refreshUrbanism();
    }, 900);
  });
  map.on('click', (e) => {
    if (!territory || !contains([e.lngLat.lng, e.lngLat.lat], territory.boundary)) return;
    const point = [e.lngLat.lng, e.lngLat.lat];
    if (checked('parcels')) {
      const label = map.queryRenderedFeatures(e.point, { layers: ['parcels-labels'] })[0];
      const parcel =
        label &&
        currentParcels.features.find(
          (f) => String(f.properties?.idu ?? f.id) === String(label.properties?.idu ?? label.id),
        );
      if (parcel) {
        displayParcel(parcel);
        return;
      }
    }

    if (checked('urbanism')) {
      const f = currentZones.features.find((f) => contains(point, f.geometry as Area));
      if (f) {
        displayZone(f);
        return;
      }
    }
    if (checked('parcels')) {
      const f = currentParcels.features.find((f) => contains(point, f.geometry as Area));
      if (f) {
        displayParcel(f);
        return;
      }
    }
    const f = currentBuildings.features.find((f) => contains(point, f.geometry as Area));
    if (f) {
      const p = f.properties ?? {};
      showInfo(
        p.nature || 'Bâtiment',
        `<p>${esc(p.usage)}</p><p>${p.heightKnown ? `Hauteur IGN : ${Number(p.height).toLocaleString('fr-FR')} m` : 'Hauteur non renseignée par l’IGN'}</p><small>Emprise BD TOPO. Toiture et fenêtres indicatives.</small>`,
        'Bâtiment IGN',
      );
    }
  });
  map.on('error', (e) => {
    const message = String(e.error?.message ?? e.error);
    if (!/Abort|aborted|cancel/i.test(message)) {
      diagnostics.errors.push(message);
      if (diagnostics.errors.length > 30) diagnostics.errors.shift();
      console.warn('[Carte]', message);
    }
  });
}
async function searchPlace() {
  const t = territory,
    q = $<HTMLInputElement>('search').value.trim();
  if (!t || q.length < 2) return;
  searchController.abort();
  searchController = new AbortController();
  const signal = searchController.signal;
  $('search-results').innerHTML = '<button disabled>Recherche…</button>';
  try {
    let results: Feature[] = [];
    if (/^(?:[0-9]?[a-z]{1,2}\s*)?\d{1,4}$/i.test(q)) {
      results = (await parcelSearch(t, q, signal)).features.filter((f) =>
        contains(geometryCenter(f.geometry as Area), t.boundary),
      );
    } else {
      const params = new URLSearchParams({
        q,
        index: 'address,poi',
        limit: '15',
        citycode: t.code,
        lon: String(t.townHall[0]),
        lat: String(t.townHall[1]),
      });
      const response = await fetchJson(`https://data.geopf.fr/geocodage/search?${params}`, signal);
      results = response.features.filter(
        (f: Feature) => f.geometry.type === 'Point' && contains(f.geometry.coordinates, t.boundary),
      );
    }
    signal.throwIfAborted();
    $('search-results').innerHTML =
      results
        .map(
          (f, i) =>
            `<button data-result="${i}">${esc(f.properties?.label ?? f.properties?.toponym ?? `${f.properties?.section ?? ''} ${f.properties?.numero ?? ''}`)}<small>${esc(f.properties?.city ?? t.name)}</small></button>`,
        )
        .join('') || '<button disabled>Aucun résultat dans cette commune.</button>';
    $('search-results').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-result]');
      if (!b) return;
      const f = results[Number(b.dataset.result)];
      $('search-results').innerHTML = '';
      if (f.geometry.type === 'Point') {
        map.flyTo({ center: f.geometry.coordinates as [number, number], zoom: 17.5, pitch: 50 });
        new maplibregl.Popup()
          .setLngLat(f.geometry.coordinates as [number, number])
          .setText(f.properties?.label ?? f.properties?.toponym ?? q)
          .addTo(map);
      } else {
        fit(f.geometry as Area);
        displayParcel(f);
      }
    };
  } catch (error) {
    if (!signal.aborted)
      $('search-results').innerHTML =
        '<button disabled>Recherche indisponible. Réessayez.</button>';
  }
}
async function boot() {
  try {
    registerRasters();
    const [communes, style] = await Promise.all([getCatalogue(), makeStyle()]);
    catalogue = communes;
    map = new maplibregl.Map({
      container: 'map',
      style,
      center: [1.3477, 42.8885],
      zoom: 15.6,
      pitch: 50,
      maxPitch: 65,
      attributionControl: { compact: true, customAttribution: '© IGN · Données ouvertes' },
      maxTileCacheSize: 90,
      refreshExpiredTiles: true,
      canvasContextAttributes: { antialias: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(
      {
        onAdd() {
          const control = document.createElement('div');
          control.className = 'maplibregl-ctrl data-control';
          const button = document.createElement('button');
          button.id = 'clear-data';
          button.textContent = 'Effacer les données';
          button.title =
            'Effacer les données de carte sauvegardées par cette application dans ce navigateur';
          button.onclick = async () => {
            button.disabled = true;
            button.textContent = 'Effacement…';
            try {
              await clearPersistentData();
              button.textContent = 'Données effacées';
              $('cache-feedback').textContent =
                'Données locales effacées. La sauvegarde reprendra au prochain chargement.';
            } catch {
              button.textContent = 'Réessayer l’effacement';
              button.disabled = false;
              $('cache-feedback').textContent =
                'Le navigateur n’a pas permis l’effacement. Réessayez.';
            }
          };
          control.append(button);
          return control;
        },
        onRemove() {
          $('clear-data')?.parentElement?.remove();
        },
      },
      'bottom-right',
    );
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    await new Promise<void>((resolve) => map.once('style.load', () => resolve()));
    details = new Details();
    map.addLayer(details);
    map.moveLayer('parcels-labels');
    setupEvents();
    $('loading').hidden = true;
    diagnostics.ready = true;
    diagnostics.catalogue = catalogue.length;
    const code = new URL(location.href).searchParams.get('commune') ?? '09182';
    await selectCommune(catalogue.some((c) => c.code === code) ? code : '09182');
  } catch (error) {
    $('boot-status').textContent =
      `Impossible de charger la carte : ${String(error)}. Rechargez la page pour réessayer.`;
    console.error(error);
  }
}
(window as any).__france3d = {
  diagnostics,
  selectCommune: (code: string) => selectCommune(code),
  getMap: () => map,
  getTerritory: () => territory,
  getBuildings: () => currentBuildings,
  getTrees: () => modelData?.trees ?? [],
  getZones: () => currentZones,
  getParcels: () => currentParcels,
  refresh: () =>
    Promise.allSettled([refreshSector(true), refreshUrbanism(true), refreshParcels(true)]),
  cache: () => ({
    models: tileModels.snapshot(),
    parcels: tileParcels.snapshot(),
    builds: modelPool.stats.builds,
    gpuAllocations: details.allocations,
    activeKeys: [...activeSectorKeys],
  }),
  settle: () => Promise.allSettled([refreshSector(), refreshParcels()]),
  persistent: () => persistentCache.snapshot(),
  network: networkStats,
  rasters: rasterStats,
};
void boot();
