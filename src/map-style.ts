import type { StyleSpecification } from 'maplibre-gl';
import { demTiles, coverTiles, orthoTiles } from './rasters';
import { empty } from './geo';
export async function makeStyle(): Promise<StyleSpecification> {
  const response = await fetch(
    'https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json',
  );
  if (!response.ok) throw Error('Fond IGN indisponible');
  const style = await response.json();
  const layers = style.layers.filter((l: any) => l.type !== 'fill-extrusion');
  const firstLine = layers.findIndex((l: any) => l.type === 'line' || l.type === 'symbol');
  layers.splice(
    firstLine,
    0,
    {
      id: 'cover',
      type: 'raster',
      source: 'cover',
      minzoom: 13,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    },
    {
      id: 'ortho',
      type: 'raster',
      source: 'ortho',
      layout: { visibility: 'none' },
      paint: { 'raster-fade-duration': 0 },
    },
  );
  for (const l of layers)
    if (l.type === 'symbol') {
      l.layout = { ...l.layout, 'text-allow-overlap': false };
    }
  const sources = {
    ...style.sources,
    dem: { type: 'raster-dem', tiles: demTiles, tileSize: 256, maxzoom: 16, encoding: 'mapbox' },
    cover: {
      type: 'raster',
      tiles: coverTiles,
      tileSize: 512,
      minzoom: 13,
      maxzoom: 16,
      attribution: '© IGN CoSIA',
    },
    ortho: { type: 'raster', tiles: orthoTiles, tileSize: 256, maxzoom: 19, attribution: '© IGN' },
    buildings: { type: 'geojson', data: empty() },
    boundary: { type: 'geojson', data: empty() },
    mask: { type: 'geojson', data: empty() },
    parcels: { type: 'geojson', data: empty() },
    zones: { type: 'geojson', data: empty() },
    selection: { type: 'geojson', data: empty() },
  };
  layers.push(
    {
      id: 'urbanism-fill',
      type: 'fill',
      source: 'zones',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'match',
          ['get', 'family'],
          'U',
          '#ca737c',
          'AU',
          '#e7ad65',
          'A',
          '#ead782',
          'N',
          '#81b08b',
          '#98a9d1',
        ],
        'fill-opacity': 0.36,
      },
    },
    {
      id: 'urbanism-lines',
      type: 'line',
      source: 'zones',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#62577d', 'line-width': 1.3 },
    },
    {
      id: 'urbanism-labels',
      type: 'symbol',
      source: 'zones',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'code'],
        'text-font': ['Source Sans Pro Regular'],
        'text-size': 13,
      },
      paint: { 'text-color': '#343044', 'text-halo-color': '#ffffff', 'text-halo-width': 1.3 },
    },
    {
      id: 'parcels-fill',
      minzoom: 14,
      type: 'fill',
      source: 'parcels',
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.01 },
    },
    {
      id: 'parcels-lines',
      minzoom: 14,
      type: 'line',
      source: 'parcels',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#7b614b', 'line-width': 1.1, 'line-opacity': 0.9 },
    },
    {
      id: 'parcels-labels',
      minzoom: 14,
      type: 'symbol',
      source: 'parcels',
      layout: {
        visibility: 'none',
        'symbol-placement': 'point',
        'text-field': ['get', 'parcelLabel'],
        'text-font': ['Source Sans Pro Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 14],
        'text-anchor': 'center',
        'text-pitch-alignment': 'viewport',
        'text-rotation-alignment': 'viewport',
        'text-allow-overlap': false,
        'text-padding': 3,
      },
      paint: {
        'text-color': '#4c3828',
        'text-halo-color': '#fffdf5',
        'text-halo-width': 1.5,
      },
    },
    {
      id: 'buildings-3d',
      minzoom: 14,
      type: 'fill-extrusion',
      source: 'buildings',
      filter: ['>', ['get', 'height'], 0],
      paint: {
        'fill-extrusion-color': '#cfc3ad',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 1,
      },
    },
    {
      id: 'outside',
      type: 'fill',
      source: 'mask',
      paint: { 'fill-color': '#e9eee8', 'fill-opacity': 0.88 },
    },
    {
      id: 'boundary-line',
      type: 'line',
      source: 'boundary',
      paint: { 'line-color': '#527366', 'line-width': 2, 'line-dasharray': [3, 2] },
    },
    {
      id: 'selection-fill',
      type: 'fill',
      source: 'selection',
      paint: { 'fill-color': '#e4ac55', 'fill-opacity': 0.28 },
    },
    {
      id: 'selection-line',
      type: 'line',
      source: 'selection',
      paint: { 'line-color': '#c08020', 'line-width': 3 },
    },
  );
  return {
    version: 8,
    glyphs: style.glyphs,
    sprite: style.sprite,
    sources,
    layers,
    terrain: { source: 'dem', exaggeration: 1 },
    light: { anchor: 'viewport', color: '#fff7df', intensity: 0.4, position: [1.5, 210, 45] },
  } as StyleSpecification;
}
