import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentCache } from '../src/persistent-cache';
let id = 0;
const name = () => `test-${++id}`;
test('prepared arrays survive a new cache instance and do not share renderer mutations', async () => {
  const db = name(),
    cache = new PersistentCache(db);
  const value = await cache.remember(
    'model/Massat/desktop/1',
    async () => ({ positions: new Float32Array([1, 2, 3]) }),
    () => 12,
  );
  value.positions[0] = 99;
  const restored = await new PersistentCache(db).remember<{ positions: Float32Array }>(
    'model/Massat/desktop/1',
    async () => {
      throw Error('must not rebuild');
    },
    () => 12,
  );
  assert.ok(restored.positions instanceof Float32Array);
  assert.deepEqual([...restored.positions], [1, 2, 3]);
});
test('expired entries are rebuilt and oldest entries evicted within the budget', async () => {
  let time = 0;
  const cache = new PersistentCache(name(), 20, () => time);
  await cache.remember(
    'a',
    async () => 'A',
    () => 10,
    undefined,
    100,
  );
  time++;
  await cache.remember(
    'b',
    async () => 'B',
    () => 10,
    undefined,
    100,
  );
  time++;
  await cache.get('a');
  time++;
  await cache.remember(
    'c',
    async () => 'C',
    () => 10,
    undefined,
    100,
  );
  assert.equal(await cache.get('b'), undefined);
  assert.equal(await cache.get('a'), 'A');
  assert.equal((await cache.snapshot()).bytes, 20);
  time = 200;
  assert.equal(await cache.get('a'), undefined);
  assert.equal(
    await cache.remember(
      'c',
      async () => 'new',
      () => 10,
    ),
    'new',
  );
});
test('clear prevents in-flight loaders and later loads from refilling storage', async () => {
  const cache = new PersistentCache(name());
  let resolve!: (value: string) => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  const loading = cache.remember(
    'slow',
    () => {
      started();
      return new Promise<string>((r) => (resolve = r));
    },
    () => 10,
  );
  await entered;
  await cache.clear();
  resolve('loaded');
  assert.equal(await loading, 'loaded');
  await cache.remember(
    'later',
    async () => 'later',
    () => 10,
  );
  assert.equal((await cache.snapshot()).entries, 0);
  assert.equal((await new PersistentCache(cache.name).snapshot()).entries, 0);
});
test('aborted or failed loaders are never stored, oversized values stay usable', async () => {
  const cache = new PersistentCache(name(), 10),
    control = new AbortController();
  await assert.rejects(
    cache.remember(
      'failed',
      async () => {
        throw Error('API down');
      },
      () => 1,
    ),
  );
  await assert.rejects(
    cache.remember(
      'cancelled',
      async () => {
        control.abort();
        return 'value';
      },
      () => 1,
      control.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(
    await cache.remember(
      'big',
      async () => 'data',
      () => 100,
    ),
    'data',
  );
  assert.equal((await cache.snapshot()).entries, 0);
});
test('unavailable storage falls back to the loader', async () => {
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });
  try {
    const cache = new PersistentCache(name());
    assert.equal(
      await cache.remember(
        'a',
        async () => 'live',
        () => 10,
      ),
      'live',
    );
    assert.ok(cache.stats.failures > 0);
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: previous,
    });
  }
});

test('clearing in another tab invalidates pending writes even without BroadcastChannel', async () => {
  const db = name(),
    first = new PersistentCache(db),
    second = new PersistentCache(db);
  let resolve!: (value: string) => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  const loading = first.remember(
    'slow',
    () => {
      started();
      return new Promise<string>((r) => (resolve = r));
    },
    () => 10,
  );
  await entered;
  await second.clear();
  resolve('old data');
  await loading;
  assert.equal((await second.snapshot()).entries, 0);
  const reopened = new PersistentCache(db);
  await reopened.remember(
    'fresh',
    async () => 'new data',
    () => 10,
  );
  assert.equal((await reopened.snapshot()).entries, 1);
});
