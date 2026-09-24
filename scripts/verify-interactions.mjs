import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const url = process.env.TEST_URL || 'http://127.0.0.1:3011/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  page = await context.newPage(),
  errors = [],
  requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => requests.push(r.url()));
const checks = {};
await page.goto(url + '?commune=09182');
await page.waitForFunction(() => window.__france3d?.diagnostics.model, {}, { timeout: 150000 });
await page.locator('#commune').fill('La Rochelle');
await page.waitForSelector('#commune-results [data-code="17300"]');
checks.homonyms = (await page.locator('#commune-results [data-code]').count()) >= 2;
await page.locator('#commune').fill('Massat');
await page.keyboard.press('Escape');
await page.locator('#search').fill('Balmes');
await page.waitForSelector('#search-results [data-result]', { timeout: 40000 });
checks.hamlet = await page.locator('#search-results').innerText();
await page.locator('#search-results [data-result]').first().click();
await page.waitForTimeout(1600);
checks.searchCenter = await page.evaluate(() => window.__france3d.getMap().getZoom() > 17);
await page.locator('#details').uncheck();
checks.hideDetails = await page.evaluate(
  () => window.__france3d.getMap().getLayoutProperty('buildings-3d', 'visibility') === 'none',
);
await page.locator('#details').check();
await page.waitForFunction(
  () => window.__france3d.diagnostics.phase === 'ready',
  {},
  { timeout: 120000 },
);
await page.locator('#urbanism').check();
await page.waitForFunction(
  () => window.__france3d.getZones().features.length > 0,
  {},
  { timeout: 60000 },
);
const clickPoint = await page.evaluate(() => {
  const app = window.__france3d,
    map = app.getMap(),
    zones = app.getZones().features;
  function inside(p, ring) {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      if (
        ring[i][1] > p[1] !== ring[j][1] > p[1] &&
        p[0] <
          ((ring[j][0] - ring[i][0]) * (p[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]
      )
        result = !result;
    return result;
  }
  for (let y = 200; y < 900; y += 30)
    for (let x = 450; x < 1300; x += 30) {
      const ll = map.unproject([x, y]),
        p = [ll.lng, ll.lat];
      for (const f of zones) {
        const polys =
          f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        if (polys.some((poly) => inside(p, poly[0]) && !poly.slice(1).some((r) => inside(p, r))))
          return { x, y };
      }
    }
  return null;
});
if (clickPoint) {
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForSelector('#info:not([hidden])');
  checks.pluClick = await page.locator('#info').innerText();
  checks.pluLink = (await page.locator('#info a').count()) > 0;
  await page.screenshot({ path: 'validation/plu-interaction.png' });
  await page.locator('#close-info').click();
}
await page.locator('#urbanism').uncheck();
await page.locator('#parcels').check();
await page.waitForFunction(
  () => window.__france3d.getParcels().features.length > 0,
  {},
  { timeout: 60000 },
);
checks.cadastre = await page.evaluate(
  () => window.__france3d.getMap().getLayoutProperty('parcels-lines', 'visibility') === 'visible',
);
await page.locator('#parcels').uncheck();
await page.evaluate(() => {
  const map = window.__france3d.getMap();
  map.jumpTo({ bearing: 75, pitch: 60 });
});
checks.rotation = await page.evaluate(
  () =>
    window.__france3d.getMap().getBearing() === 75 && window.__france3d.getMap().getPitch() === 60,
);
// A new selection cancels all work belonging to the previous commune.
await page.evaluate(() => {
  void window.__france3d.selectCommune('75056');
  setTimeout(() => void window.__france3d.selectCommune('09122'), 80);
  setTimeout(() => void window.__france3d.selectCommune('09182'), 160);
});
await page.waitForFunction(
  () => window.__france3d.diagnostics.commune === '09182' && window.__france3d.diagnostics.model,
  {},
  { timeout: 150000 },
);
checks.switchRace = await page.evaluate(() => {
  const a = window.__france3d;
  return (
    a.getTerritory().code === '09182' &&
    a.diagnostics.model.outsideBuildings === 0 &&
    a.diagnostics.model.outsideTrees === 0
  );
});
// Pan into a different part of the same commune and require a new model.
const initialTime = await page.evaluate(() => window.__france3d.diagnostics.timings.modelMs);
await page.evaluate(() =>
  window.__france3d.getMap().jumpTo({ center: [1.3605, 42.891], zoom: 16.4 }),
);
await page.waitForFunction(
  (before) =>
    window.__france3d.diagnostics.phase === 'ready' &&
    window.__france3d.diagnostics.timings.modelMs !== before,
  initialTime,
  { timeout: 150000 },
);
checks.panSecondSector = await page.evaluate(
  () =>
    window.__france3d.diagnostics.model.finite && window.__france3d.diagnostics.buildingCount > 0,
);
// The municipal overview must clear detailed geometry, then a close view restores it.
await page.locator('#extent').click();
await page.waitForTimeout(1700);
checks.overview = await page.evaluate(() => window.__france3d.getMap().getZoom() < 14);
await page.locator('#center').click();
await page.waitForTimeout(1600);
await page.waitForFunction(
  () => window.__france3d.diagnostics.phase === 'ready' && window.__france3d.diagnostics.model,
  {},
  { timeout: 150000 },
);
await page.screenshot({ path: 'validation/desktop-final.png' });
const fps = await page.evaluate(async () => {
  const map = window.__france3d.getMap(),
    frames = [];
  let previous = performance.now(),
    started = previous;
  return await new Promise((resolve) => {
    function frame(t) {
      frames.push(t - previous);
      previous = t;
      if (t - started < 1500) {
        map.setBearing(map.getBearing() + 0.6);
        requestAnimationFrame(frame);
      } else {
        frames.sort((a, b) => a - b);
        resolve({
          medianFrameMs: frames[Math.floor(frames.length * 0.5)],
          p95FrameMs: frames[Math.floor(frames.length * 0.95)],
          frames: frames.length,
        });
      }
    }
    requestAnimationFrame(frame);
  });
});
const localPaths = [
  ...new Set(requests.filter((r) => r.startsWith(url)).map((r) => new URL(r).pathname)),
];
await fs.writeFile(
  'validation/interactions-report.json',
  JSON.stringify({ date: new Date().toISOString(), checks, errors, fps, localPaths }, null, 2),
);
await context.close();
const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  }),
  phone = await mobile.newPage();
await phone.goto(url + '?commune=09182');
await phone.waitForFunction(() => window.__france3d?.diagnostics.model, {}, { timeout: 150000 });
await phone.screenshot({ path: 'validation/mobile-final.png' });
const mobileResult = await phone.evaluate(() => ({
  model: window.__france3d.diagnostics.model,
  overflow: document.documentElement.scrollWidth > innerWidth,
  sidebar: document.querySelector('#sidebar').getBoundingClientRect().toJSON(),
  canvas: document.querySelector('canvas').getBoundingClientRect().toJSON(),
}));
await phone.locator('#collapse').click();
await phone.locator('#parcels').check();
await phone.waitForFunction(
  () => window.__france3d.diagnostics.parcels?.count > 0,
  {},
  { timeout: 60000 },
);
await phone.screenshot({ path: 'validation/mobile-tools.png' });
await fs.writeFile('validation/mobile-report.json', JSON.stringify(mobileResult, null, 2));
await mobile.close();
await browser.close();
console.log(
  JSON.stringify(
    { checks, errors, fps, mobile: mobileResult.model, overflow: mobileResult.overflow },
    null,
    2,
  ),
);
