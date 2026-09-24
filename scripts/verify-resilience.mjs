import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:3011/?commune=09182');
await page.waitForFunction(() => window.__france3d?.diagnostics.ready, {}, { timeout: 60000 });
await page.route('**/geo.api.gouv.fr/communes/46256?**', (route) =>
  route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{"error":"validation outage"}',
  }),
);
await page.evaluate(() => window.__france3d.selectCommune('46256'));
const boundaryFailure = await page.evaluate(() => ({
  phase: window.__france3d.diagnostics.phase,
  message: document.querySelector('#status').textContent,
  oldBuildings: window.__france3d.getBuildings().features.length,
}));
await page.unroute('**/geo.api.gouv.fr/communes/46256?**');
await page.route('**/apicarto.ign.fr/api/gpu/**', (route) =>
  route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{"error":"validation outage"}',
  }),
);
await page.evaluate(() => {
  void window.__france3d.selectCommune('09182');
});
await page.waitForFunction(
  () =>
    window.__france3d.diagnostics.model &&
    window.__france3d.diagnostics.urbanism?.status === 'error',
  {},
  { timeout: 150000 },
);
const independentLayers = await page.evaluate(() => ({
  model: window.__france3d.diagnostics.model,
  urbanism: window.__france3d.diagnostics.urbanism,
  message: document.querySelector('#status').textContent,
}));
await page.unroute('**/apicarto.ign.fr/api/gpu/**');
await page.evaluate(() => window.__france3d.selectCommune('09182'));
await page.waitForFunction(
  () =>
    window.__france3d.diagnostics.model &&
    window.__france3d.diagnostics.urbanism?.status === 'available',
  {},
  { timeout: 150000 },
);
const recovery = await page.evaluate(() => ({
  phase: window.__france3d.diagnostics.phase,
  buildings: window.__france3d.diagnostics.buildingCount,
  urbanism: window.__france3d.diagnostics.urbanism.count,
  alignedTrees: window.__france3d
    .getTrees()
    .slice(0, 100)
    .map((t) => Math.abs(t.z - window.__france3d.getMap().queryTerrainElevation([t.lon, t.lat]))),
}));
await fs.writeFile(
  'validation/resilience-report.json',
  JSON.stringify(
    { date: new Date().toISOString(), boundaryFailure, independentLayers, recovery, errors },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      boundaryFailure,
      recovered: recovery.phase,
      plu: recovery.urbanism,
      treeAlignmentMax: Math.max(...recovery.alignedTrees),
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
if (
  boundaryFailure.phase !== 'error' ||
  boundaryFailure.oldBuildings !== 0 ||
  recovery.phase !== 'ready' ||
  errors.length
)
  process.exitCode = 1;
