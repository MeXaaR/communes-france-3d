import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const label = process.env.LABEL || 'after';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const counts = { buildings: 0, parcels: 0 },
  errors = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.searchParams.get('REQUEST') !== 'GetFeature') return;
  const t = u.searchParams.get('TYPENAMES');
  if (t === 'BDTOPO_V3:batiment') counts.buildings++;
  if (t === 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle') counts.parcels++;
});
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:3011/?commune=09182');
await page.waitForFunction(
  () => window.__france3d?.diagnostics.phase === 'ready' && window.__france3d?.diagnostics.model,
  {},
  { timeout: 180000 },
);
await page.locator('#parcels').check();
await page.waitForFunction(
  () => window.__france3d.diagnostics.parcels?.count > 0,
  {},
  { timeout: 60000 },
);
await page.evaluate(() => window.__france3d.refresh());
const steps = [];
for (const [name, center] of [
  ['small', [1.3479, 42.8885]],
  ['next', [1.3539, 42.8885]],
  ['return', [1.3477, 42.8885]],
]) {
  const cachedBefore = await page.evaluate(() => window.__france3d.cache?.());
  const before = { ...counts },
    start = Date.now();
  const snapshot = await page.evaluate(async (center) => {
    window.__france3d.getMap().jumpTo({ center });
    const start = performance.now();
    await window.__france3d.settle();
    window.__france3d.diagnostics.lastNavigationSettleMs = performance.now() - start;
    return window.__france3d.diagnostics;
  }, center);
  await page.waitForFunction(
    () => window.__france3d.diagnostics.phase === 'ready',
    {},
    { timeout: 180000 },
  );
  const cachedAfter = await page.evaluate(() => window.__france3d.cache?.());
  steps.push({
    cacheBefore: cachedBefore,
    cacheAfter: cachedAfter,
    name,
    ms: Date.now() - start,
    requests: {
      buildings: counts.buildings - before.buildings,
      parcels: counts.parcels - before.parcels,
    },
    diagnostics: snapshot,
  });
  console.log(label, name, steps.at(-1).ms, JSON.stringify(steps.at(-1).requests));
  if (label === 'after' && name !== 'next') {
    assert.deepEqual(steps.at(-1).requests, { buildings: 0, parcels: 0 });
    assert.equal(cachedAfter.builds, cachedBefore.builds);
    assert.equal(cachedAfter.gpuAllocations, cachedBefore.gpuAllocations);
  }
}
await page.screenshot({ path: `validation/navigation-${label}.png` });
await fs.writeFile(
  `validation/navigation-${label}.json`,
  JSON.stringify({ label, steps, errors }, null, 2),
);
await browser.close();
