import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, clip, coverClass } from '../src/model.ts';
import { boxGeometry, contains, mercator, lngLat, normalize, safeUrl } from '../src/geo.ts';
import {
  findCommunes,
  normalizeBuildings,
  wfs,
  parcelSearch,
  normalizeZones,
} from '../src/services.ts';
const boundary = boxGeometry([1, 42, 1.02, 42.02]);
const toGeometry = (points: number[][]) => ({ type: 'Polygon' as const, coordinates: [points] });
test('Les limites communales respectent les trous et découpent les bâtiments', () => {
  const area = {
    ...boundary,
    coordinates: [
      ...boundary.coordinates,
      boxGeometry([1.005, 42.005, 1.01, 42.01]).coordinates[0],
    ],
  };
  assert.equal(contains([1.007, 42.007], area), false);
  const data: any = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'a' },
        geometry: boxGeometry([1.004, 42.004, 1.012, 42.012]),
      },
      { type: 'Feature', properties: { id: 'b' }, geometry: boxGeometry([2, 43, 3, 44]) },
    ],
  };
  const clipped = clip(data, area);
  assert.equal(clipped.features.length, 1);
  assert.equal(contains([1.007, 42.007], clipped.features[0].geometry as any), false);
});
test('Aucune hauteur IGN absente ne devient une hauteur inventée', () => {
  const f = (hauteur: any) => ({ type: 'Feature', geometry: boundary, properties: { hauteur } });
  const output = normalizeBuildings({
    type: 'FeatureCollection',
    features: [f(null), f(-1), f('32.7')] as any,
  });
  assert.deepEqual(
    output.features.map((f) => f.properties!.height),
    [0, 0, 32.7],
  );
});
test('Toitures, fenêtres, arbres et altitude restent finis avec un bâtiment haut et un trou', () => {
  const origin: [number, number] = [1.01, 42.01],
    m = mercator(origin),
    bounds: [number, number, number, number] = [m[0] - 100, m[1] - 100, m[0] + 100, m[1] + 100];
  const corners = [
    [m[0] - 20, m[1] - 15],
    [m[0] + 20, m[1] - 15],
    [m[0] + 20, m[1] + 15],
    [m[0] - 20, m[1] + 15],
    [m[0] - 20, m[1] - 15],
  ].map((p) => lngLat(p[0], p[1]));
  const buildings: any = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: toGeometry(corners), properties: { id: 'church', height: 48 } },
    ],
  };
  const input: any = {
    buildings,
    boundary,
    origin,
    bounds,
    ground: { bounds, size: 2, values: [-4, -4, -4, -4] },
    covers: [{ bounds, size: 100, classes: new Uint8Array(10000).fill(9), source: 'test' }],
    forests: { type: 'FeatureCollection', features: [] },
    limit: 100,
    treeLimit: 1000,
  };
  const output = generate(input);
  assert.equal(output.stats.maxHeight, 48);
  assert.equal(output.stats.finite, true);
  assert(output.stats.windows > 0);
  assert(output.stats.trees > 0);
  assert(output.trees.every((t) => Math.abs(t.z + 4) < 1e-9));
  assert(Math.max(...output.positions.filter((_, i) => i % 3 === 2)) <= 44.001);
  const second = generate(input);
  assert.deepEqual(second.trees, output.trees);
});
test('Les arbres évitent les classes non boisées et les limites à la taille du houppier', () => {
  const origin: [number, number] = [1.01, 42.01],
    m = mercator(origin),
    bounds: [number, number, number, number] = [m[0] - 100, m[1] - 100, m[0] + 100, m[1] + 100],
    classes = new Uint8Array(10000).fill(9);
  for (let y = 0; y < 100; y++) for (let x = 45; x < 55; x++) classes[y * 100 + x] = 3;
  const tile: any = { bounds, size: 100, classes, source: 'test' };
  const output = generate({
    buildings: { type: 'FeatureCollection', features: [] },
    boundary,
    origin,
    bounds,
    ground: { bounds, size: 2, values: [0, 0, 0, 0] },
    covers: [tile],
    forests: { type: 'FeatureCollection', features: [] },
    limit: 50,
    treeLimit: 1000,
  });
  const scale = Math.cos((origin[1] * Math.PI) / 180);
  for (const tree of output.trees) {
    const p = mercator([tree.lon, tree.lat]);
    for (let k = 0; k < 8; k++) {
      const q = [
        p[0] + (Math.cos((k * Math.PI) / 4) * (tree.radius + 2)) / scale,
        p[1] + (Math.sin((k * Math.PI) / 4) * (tree.radius + 2)) / scale,
      ];
      assert.equal(coverClass(q, [tile]), 9);
      assert(contains(lngLat(q[0], q[1]), boundary));
    }
  }
});
test('Recherche de communes : accents, code INSEE, homonymes et codes postaux', () => {
  const sample: any = [
    {
      code: '17300',
      name: 'La Rochelle',
      department: '17',
      population: 79851,
      postcodes: ['17000'],
    },
    { code: '70450', name: 'La Rochelle', department: '70', population: 40, postcodes: ['70120'] },
    { code: '46256', name: 'Saint-Cirq-Lapopie', population: 201, postcodes: ['46330'] },
  ];
  assert.equal(findCommunes(sample, 'LA ROCHELLE')[0].code, '17300');
  assert.equal(findCommunes(sample, '70120')[0].code, '70450');
  assert.equal(findCommunes(sample, 'saint cirq')[0].code, '46256');
  assert.equal(normalize('Évry-Courcouronnes'), 'evry courcouronnes');
  assert.equal(safeUrl('javascript:alert(1)'), '');
});
test('Pagination WFS complète même quand le serveur renvoie une petite page', async () => {
  const original = globalThis.fetch;
  const offsets: number[] = [];
  globalThis.fetch = async (input: any) => {
    const offset = Number(new URL(input).searchParams.get('STARTINDEX'));
    offsets.push(offset);
    return new Response(
      JSON.stringify({
        type: 'FeatureCollection',
        numberMatched: 5,
        features: Array.from({ length: Math.min(2, 5 - offset) }, (_, i) => ({
          type: 'Feature',
          id: offset + i,
          geometry: boundary,
          properties: {},
        })),
      }),
    );
  };
  try {
    const output = await wfs('test', undefined, new AbortController().signal);
    assert.equal(output.features.length, 5);
    assert.deepEqual(offsets, [0, 2, 4]);
  } finally {
    globalThis.fetch = original;
  }
});
test('Une page WFS vide prématurée est signalée, pas présentée comme complète', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: 5, features: [] }));
  try {
    await assert.rejects(wfs('test', undefined, new AbortController().signal), /incomplète/);
  } finally {
    globalThis.fetch = original;
  }
});

test('Parcelles : sections préfixées par zéro et arrondissements de Paris', async () => {
  const original = globalThis.fetch;
  const filters: string[] = [];
  globalThis.fetch = async (input: any) => {
    filters.push(new URL(input).searchParams.get('CQL_FILTER') ?? '');
    return new Response(
      JSON.stringify({ type: 'FeatureCollection', numberMatched: 0, features: [] }),
    );
  };
  try {
    await parcelSearch({ code: '09057' } as any, '0B 1281', new AbortController().signal);
    await parcelSearch({ code: '75056' } as any, 'AB 123', new AbortController().signal);
    assert.match(filters[0], /section='0B'/);
    assert.match(filters[1], /75101/);
    assert.match(filters[1], /75120/);
    assert.match(filters[1], /numero='0123'/);
  } finally {
    globalThis.fetch = original;
  }
});
test('Un PLUi fournit son règlement et ses annexes même sans URLFIC', () => {
  const zones = normalizeZones(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: boundary,
          properties: {
            gpu_doc_id: '4f3ddc27a9611b4bc94fa161443b8e86',
            nomfic: '200046977_reglement_20260326.pdf',
            libelle: 'UCe1b',
            datvalid: '20260326',
          },
        },
      ],
    },
    'PLU / PLUi',
    'GPU',
  );
  const p = zones[0].properties!;
  assert.equal(
    p.url,
    'https://www.geoportail-urbanisme.gouv.fr/api/document/4f3ddc27a9611b4bc94fa161443b8e86/files/200046977_reglement_20260326.pdf',
  );
  assert.match(p.documentUrl, /document\/by-id/);
  assert.equal(p.dateLabel, 'Version du document');
});

test('Les toitures ne ferment pas les cours intérieures', () => {
  const origin: [number, number] = [1.01, 42.01],
    m = mercator(origin),
    bounds: [number, number, number, number] = [m[0] - 100, m[1] - 100, m[0] + 100, m[1] + 100];
  const ring = (d: number) =>
    [
      [-d, -d],
      [d, -d],
      [d, d],
      [-d, d],
      [-d, -d],
    ].map((p) => lngLat(m[0] + p[0], m[1] + p[1]));
  const footprint = { type: 'Polygon' as const, coordinates: [ring(15), ring(6)] };
  const output = generate({
    buildings: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: footprint, properties: { id: 'cour', height: 8 } }],
    },
    boundary,
    origin,
    bounds,
    ground: { bounds, size: 2, values: [0, 0, 0, 0] },
    covers: [],
    forests: { type: 'FeatureCollection', features: [] },
    limit: 10,
    treeLimit: 0,
  });
  assert(output.stats.roofs > 0);
  let roofs = 0;
  const half = 6 * Math.cos((origin[1] * Math.PI) / 180);
  for (let i = 0; i < output.positions.length; i += 9) {
    const t = Array.from(output.positions.slice(i, i + 9));
    if (Math.min(t[2], t[5], t[8]) < 5.5) continue;
    const x = (t[0] + t[3] + t[6]) / 3,
      y = (t[1] + t[4] + t[7]) / 3;
    assert(!(Math.abs(x) < half - 0.001 && Math.abs(y) < half - 0.001));
    roofs++;
  }
  assert(roofs > 0);
});

test('Déplacer la caméra ne déplace pas les arbres déjà présents', () => {
  const origin: [number, number] = [1.01, 42.01],
    m = mercator(origin),
    bounds: [number, number, number, number] = [m[0] - 100, m[1] - 100, m[0] + 100, m[1] + 100],
    input: any = {
      buildings: { type: 'FeatureCollection', features: [] },
      boundary,
      origin,
      bounds,
      ground: { bounds, size: 2, values: [0, 0, 0, 0] },
      covers: [{ bounds, size: 100, classes: new Uint8Array(10000).fill(9), source: 'test' }],
      forests: { type: 'FeatureCollection', features: [] },
      limit: 10,
      treeLimit: 1000,
    };
  const a = generate(input),
    b = generate({ ...input, origin: [1.011, 42.011] });
  const positions = new Set(a.trees.map((t) => `${t.lon}/${t.lat}`));
  assert(b.trees.length > 0);
  assert(b.trees.filter((t) => positions.has(`${t.lon}/${t.lat}`)).length / b.trees.length > 0.99);
});
