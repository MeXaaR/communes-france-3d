import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const base = process.env.TEST_URL || 'http://127.0.0.1:3010/';
const cases = [
  ['09057', 'Biert', 'Village'],
  ['09182', 'Massat', 'Village de montagne'],
  ['46256', 'Saint-Cirq-Lapopie', 'Petit village'],
  ['09122', 'Foix', 'Petite ville'],
  ['81004', 'Albi', 'Ville moyenne'],
  ['17300', 'La Rochelle', 'Ville moyenne littorale'],
  ['74056', 'Chamonix-Mont-Blanc', 'Commune alpine'],
  ['75056', 'Paris', 'Grande ville'],
  ['69123', 'Lyon', 'Grande ville'],
  ['97411', 'Saint-Denis', 'Ville de La Réunion'],
];
const selected = process.env.COMMUNES
  ? cases.filter((c) => process.env.COMMUNES.split(',').includes(c[0]))
  : cases;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const jsErrors = [],
  requests = [],
  responses = [];
page.on('pageerror', (e) => jsErrors.push(e.message));
page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
page.on('response', (r) => {
  if (r.status() >= 400) responses.push({ url: r.url(), status: r.status() });
});
await page.goto(base + '?commune=' + selected[0][0]);
await page.waitForFunction(() => window.__france3d?.diagnostics.ready, {}, { timeout: 60000 });
const results = [];
for (const [index, [code, name, category]] of selected.entries()) {
  console.log('START', code, name);
  const started = Date.now(),
    errorsBefore = jsErrors.length,
    reqBefore = requests.length;
  try {
    if (index)
      await page.evaluate((code) => {
        void window.__france3d.selectCommune(code);
      }, code);
    await page.waitForFunction(
      (code) =>
        window.__france3d?.diagnostics.commune === code && !!window.__france3d.diagnostics.model,
      code,
      { timeout: 150000 },
    );
    await page.locator('#parcels').check();
    await page.waitForFunction(
      () => window.__france3d.diagnostics.parcels?.count > 0,
      {},
      { timeout: 90000 },
    );
    await page.waitForFunction(
      () => !!window.__france3d.diagnostics.urbanism,
      {},
      { timeout: 90000 },
    );
    await page.waitForTimeout(1200);
    await page.waitForFunction(
      () => {
        const app = window.__france3d,
          map = app.getMap();
        return app
          .getTrees()
          .slice(0, 30)
          .every((t) => Math.abs(t.z - (map.queryTerrainElevation([t.lon, t.lat]) ?? t.z)) < 0.5);
      },
      {},
      { timeout: 45000 },
    );
    const diagnostics = await page.evaluate(() => {
      const app = window.__france3d,
        map = app.getMap(),
        trees = app.getTrees();
      return {
        ...app.diagnostics,
        map: {
          loaded: map.loaded(),
          center: map.getCenter().toArray(),
          elevation: map.queryTerrainElevation(map.getCenter()),
          zoom: map.getZoom(),
        },
        treeAlignment: trees.slice(0, 30).map((t) => ({
          z: t.z,
          mapZ: map.queryTerrainElevation([t.lon, t.lat]),
          difference: Math.abs(t.z - (map.queryTerrainElevation([t.lon, t.lat]) ?? 0)),
        })),
        heapBytes: performance.memory?.usedJSHeapSize,
      };
    });
    const check = {
      boundary: diagnostics.boundary?.townHallInside,
      buildings: diagnostics.buildingCount > 0,
      finite: diagnostics.model?.finite,
      treeGround: diagnostics.treeAlignment.every((t) => t.difference < 0.5),
      contained: diagnostics.model?.outsideBuildings === 0 && diagnostics.model?.outsideTrees === 0,
      ground:
        Number.isFinite(diagnostics.map.elevation) && Math.abs(diagnostics.map.elevation) > 0.01,
      parcels: diagnostics.parcels.count > 0,
      urbanismReported: !!diagnostics.urbanism.status,
      noJsErrors: jsErrors.length === errorsBefore,
    };
    await page.screenshot({ path: `validation/${code}-${name.replaceAll(' ', '-')}.png` });
    // The visible parcel can also be found by its cadastral section and number.
    const parcel = diagnostics.parcels.sample;
    let parcelSearch = false;
    if (parcel) {
      await page.locator('#search').fill(`${parcel.section} ${parcel.numero}`);
      await page.waitForFunction(
        () => !!document.querySelector('#search-results [data-result]'),
        {},
        { timeout: 45000 },
      );
      parcelSearch = true;
      await page.locator('#search').fill('');
    }
    results.push({
      code,
      name,
      category,
      seconds: (Date.now() - started) / 1000,
      check,
      parcelSearch,
      diagnostics,
      requests: requests.length - reqBefore,
      jsErrors: jsErrors.slice(errorsBefore),
    });
    console.log(
      'PASS',
      code,
      JSON.stringify({
        check,
        buildings: diagnostics.buildingCount,
        trees: diagnostics.model.trees,
        plu: diagnostics.urbanism.count,
        seconds: (Date.now() - started) / 1000,
      }),
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => window.__france3d?.diagnostics).catch(() => null);
    results.push({ code, name, category, error: String(error), diagnostics });
    await page.screenshot({ path: `validation/${code}-error.png` }).catch(() => {});
    console.log('FAIL', code, String(error));
  }
  await fs.writeFile(
    'validation/communes-report.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        base,
        results,
        jsErrors,
        responses,
        localRequests: [
          ...new Set(
            requests.filter((r) => r.url.startsWith(base)).map((r) => new URL(r.url).pathname),
          ),
        ],
        remoteHosts: [
          ...new Set(
            requests.filter((r) => !r.url.startsWith(base)).map((r) => new URL(r.url).hostname),
          ),
        ],
      },
      null,
      2,
    ),
  );
}
await browser.close();
if (results.some((r) => r.error || Object.values(r.check).some((v) => !v))) process.exitCode = 1;
