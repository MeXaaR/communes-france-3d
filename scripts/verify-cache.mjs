import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = [];
try {
  for (const [name, code, mobile] of [
    ['lyon', '69123', false],
    ['massat-mobile', '09182', true],
  ]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const ready = () =>
      page.waitForFunction(
        () => {
          const a = window.__france3d;
          if (!a?.diagnostics.ready) return false;
          const c = a.cache();
          return (
            a?.diagnostics.phase === 'ready' &&
            c.models.pending === 0 &&
            c.activeKeys.length === a.diagnostics.cache.visibleChunks
          );
        },
        {},
        { timeout: 240000 },
      );
    await page.goto(`http://127.0.0.1:3011/?commune=${code}`);
    await ready();
    if (mobile) await page.locator('#collapse').click();
    await page.locator('#parcels').check();
    await page.evaluate(() => window.__france3d.settle());
    console.log(name, 'modèles et cadastre chargés');
    const initial = await page.evaluate(() => ({
      cache: window.__france3d.cache(),
      diagnostics: window.__france3d.diagnostics,
      center: window.__france3d.getMap().getCenter().toArray(),
    }));
    assert(initial.diagnostics.model.finite);
    assert.equal(initial.diagnostics.model.outsideTrees, 0);
    assert(initial.cache.models.bytes <= initial.cache.models.maxBytes);
    assert(initial.cache.parcels.bytes <= initial.cache.parcels.maxBytes);
    assert.equal(initial.cache.models.evictions, 0, 'The active view must fit in its budget');
    assert(initial.cache.models.entries >= 9);
    await page.locator('#details').uncheck();
    await page.locator('#details').check();
    await page.locator('#parcels').uncheck();
    await page.locator('#parcels').check();
    await page.evaluate(() => window.__france3d.settle());
    assert(!/masqués|masquées/.test(await page.locator('#status').innerText()));
    const toggle = await page.evaluate(() => window.__france3d.cache());
    assert.equal(toggle.builds, initial.cache.builds);
    assert.equal(toggle.gpuAllocations, initial.cache.gpuAllocations);
    await page.evaluate(() => window.__france3d.getMap().jumpTo({ zoom: 12 }));
    await page.evaluate(() => window.__france3d.settle());
    const overview = await page.evaluate(() => window.__france3d.diagnostics.cache);
    assert.equal(overview.visibleChunks, 0);
    assert.equal(overview.models.entries, initial.cache.models.entries);
    await page.evaluate(() =>
      window.__france3d.getMap().jumpTo({ zoom: 15.6, bearing: 45, pitch: 55 }),
    );
    const start = Date.now();
    await page.evaluate(() => window.__france3d.settle());
    await ready();
    const restoreMs = Date.now() - start;
    const restored = await page.evaluate(() => ({
      cache: window.__france3d.cache(),
      diagnostics: window.__france3d.diagnostics,
      treeUnique:
        new Set(window.__france3d.getTrees().map((t) => `${t.lon}/${t.lat}`)).size ===
        window.__france3d.getTrees().length,
      parcelUnique:
        new Set(window.__france3d.getParcels().features.map((f) => f.id)).size ===
        window.__france3d.getParcels().features.length,
      overflow: document.documentElement.scrollWidth > innerWidth,
      renderedParcels: window.__france3d
        .getMap()
        .queryRenderedFeatures({ layers: ['parcels-lines'] }).length,
    }));
    assert.equal(restored.cache.builds, initial.cache.builds);
    assert.equal(restored.cache.gpuAllocations, initial.cache.gpuAllocations);
    assert(restored.treeUnique);
    assert(restored.parcelUnique);
    assert(!restored.overflow);
    await page.waitForFunction(
      () =>
        window.__france3d.getMap().queryRenderedFeatures({ layers: ['parcels-lines'] }).length > 0,
      {},
      { timeout: 30000 },
    );
    if (mobile) await page.locator('#collapse').click();
    await page.screenshot({ path: `validation/cache-${name}.png` });
    assert.deepEqual(errors, []);
    reports.push({ name, initial, toggle, overview, restored, restoreMs, errors });
    console.log(
      name,
      JSON.stringify({ restoreMs, cache: restored.cache, model: restored.diagnostics.model }),
    );
    if (!mobile) {
      await page.evaluate(() => {
        void window.__france3d.selectCommune('75056');
        setTimeout(() => void window.__france3d.selectCommune('09122'), 100);
      });
      await page.waitForFunction(
        () =>
          window.__france3d.diagnostics.commune === '09122' &&
          window.__france3d.diagnostics.phase === 'ready',
        {},
        { timeout: 240000 },
      );
      const switched = await page.evaluate(() => ({
        territory: window.__france3d.getTerritory().code,
        diagnostics: window.__france3d.diagnostics,
        cache: window.__france3d.cache(),
      }));
      assert.equal(switched.territory, '09122');
      assert.equal(switched.diagnostics.model.outsideTrees, 0);
      assert.equal(switched.diagnostics.model.outsideBuildings, 0);
      reports.push({ name: 'rapid-switch-to-foix', ...switched });
      console.log('rapid-switch-to-foix OK');
    }
    await context.close();
    await fs.writeFile('validation/cache-regressions.json', JSON.stringify(reports, null, 2));
  }
} finally {
  await browser.close();
}
