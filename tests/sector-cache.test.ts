import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SectorCache,
  sectorAt,
  sector,
  surroundingSectors,
  ownedFeatures,
} from '../src/sector-cache.ts';
import { boxGeometry, empty, lngLat } from '../src/geo.ts';
import { generate } from '../src/model.ts';

test('La grille reste fixe et deux vues voisines partagent six secteurs sur neuf', () => {
  const center = sectorAt([1.3477, 42.8885]);
  const boundary: [number, number, number, number] = [-180, -85, 180, 85];
  const keys = (point: number[]) =>
    surroundingSectors(point, boundary)
      .map((t) => t.key)
      .sort();
  const a = keys(center.origin);
  assert.deepEqual(keys([center.origin[0] + 0.0001, center.origin[1]]), a);
  const b = keys(sector(center.x + 1, center.y).origin);
  assert.equal(b.filter((k) => a.includes(k)).length, 6);
});

test('Un bâtiment traversant deux secteurs conserve son emprise entière dans un seul secteur', () => {
  const a = sectorAt([1.3477, 42.8885]),
    b = sector(a.x + 1, a.y);
  const edge = a.geographic[2],
    y = a.origin[1];
  const feature: any = {
    type: 'Feature',
    id: 'crossing',
    properties: {},
    geometry: boxGeometry([edge - 0.0001, y - 0.0001, edge + 0.0003, y + 0.0001]),
  };
  const collection: any = { type: 'FeatureCollection', features: [feature] };
  const owners = [a, b].flatMap((tile) => ownedFeatures(collection, tile).features);
  assert.equal(owners.length, 1);
  assert.equal(owners[0], feature);
});

test('Les arbres voisins ne sont pas dupliqués à la jointure de deux secteurs', () => {
  const a = sectorAt([1.3477, 42.8885]),
    b = sector(a.x + 1, a.y);
  const bounds: [number, number, number, number] = [
    a.projected[0] - 100,
    a.projected[1] - 100,
    b.projected[2] + 100,
    b.projected[3] + 100,
  ];
  const lo = lngLat(bounds[0], bounds[1]),
    hi = lngLat(bounds[2], bounds[3]);
  const models = [a, b].map((tile) =>
    generate({
      buildings: empty(),
      boundary: boxGeometry([lo[0], lo[1], hi[0], hi[1]]),
      origin: tile.origin,
      bounds: tile.projected,
      ground: { bounds, size: 2, values: [0, 0, 0, 0] },
      covers: [{ bounds, size: 2, classes: new Uint8Array(4).fill(9), source: 'test' } as any],
      forests: empty(),
      limit: 0,
      treeLimit: 10000,
    }),
  );
  assert(models.every((m) => m.trees.length > 0));
  const trees = models.flatMap((m) => m.trees);
  assert.equal(new Set(trees.map((t) => `${t.lon}/${t.lat}`)).size, trees.length);
  models.forEach((m, i) =>
    assert(m.trees.every((t) => sectorAt([t.lon, t.lat]).key === [a, b][i].key)),
  );
});

test('Les appels simultanés partagent un chargement et les retours réutilisent le même objet', async () => {
  const cache = new SectorCache<object>(100, 5);
  let resolve!: (v: object) => void,
    loads = 0,
    weighings = 0;
  const loader = () => {
    loads++;
    return new Promise<object>((r) => {
      resolve = r;
    });
  };
  const weight = () => {
    weighings++;
    return 10;
  };
  const first = cache.get('a', loader, weight),
    second = cache.get('a', loader, weight);
  const value = {};
  resolve(value);
  assert.equal(await first, value);
  assert.equal(await second, value);
  assert.equal(await cache.get('a', loader, weight), value);
  assert.equal(loads, 1);
  assert.equal(weighings, 1);
  assert.equal(cache.snapshot().shared, 1);
});

test('Le cache évince les anciens secteurs, protège la vue et respecte son budget', async () => {
  const removed: string[] = [];
  const cache = new SectorCache<number>(30, 3, (key) => removed.push(key));
  const put = (key: string) =>
    cache.get(
      key,
      async () => 10,
      (v) => v,
    );
  await put('a');
  await put('b');
  await put('c');
  await put('a');
  await put('d');
  assert.deepEqual(removed, ['b']);
  cache.protect(['c']);
  await put('e');
  assert.deepEqual(removed, ['b', 'a']);
  cache.protect(['c', 'd', 'e', 'f']);
  await put('f');
  assert.equal(cache.bytes, 30);
  assert.equal(cache.entries.size, 3);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.entries.size, 0);
  assert.equal(removed.length, 6);
});

test('Un ancien chargement ne réintroduit pas les données de la commune quittée', async () => {
  const cache = new SectorCache<number>(100, 3);
  let complete!: (value: number) => void;
  const stale = cache.get(
    'same-key',
    () =>
      new Promise<number>((r) => {
        complete = r;
      }),
    (v) => v,
  );
  cache.clear();
  await cache.get(
    'same-key',
    async () => 20,
    (v) => v,
  );
  complete(10);
  await assert.rejects(stale, { name: 'AbortError' });
  assert.equal(cache.peek('same-key'), 20);
  assert.equal(cache.bytes, 20);
});

test('Un chargement échoué peut être retenté sans conserver de promesse bloquée', async () => {
  const cache = new SectorCache<number>(100, 3);
  await assert.rejects(
    cache.get(
      'a',
      async () => {
        throw Error('offline');
      },
      (v) => v,
    ),
  );
  assert.equal(cache.pending.size, 0);
  assert.equal(
    await cache.get(
      'a',
      async () => 10,
      (v) => v,
    ),
    10,
  );
});
