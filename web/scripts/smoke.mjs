// Drive the built app in a real browser and report what a reader would actually get.
//
//   npm run smoke            # checks, exits non-zero on failure
//   npm run smoke -- --shots # also writes screenshots to build/screenshots
//
// Uses the Chrome already on the machine rather than downloading one. The point is to
// catch what unit tests cannot: a map that renders nothing, a page that scrolls
// sideways on a phone, a console error, a direct link that lands on the wrong place.

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA = resolve(ROOT, '..', 'build');
const SHOTS = join(DATA, 'screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.png': 'image/png',
};

/** Serves dist, with /data/ mapped to the published build directory. */
function serve() {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const target = path.startsWith('/data/')
      ? join(DATA, path.slice('/data/'.length))
      : join(DIST, path);

    let file = target;
    if (!existsSync(file) || !extname(file)) file = join(DIST, 'index.html');

    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

const problems = [];
const notes = [];

function check(condition, message) {
  if (!condition) problems.push(message);
  return condition;
}

async function main() {
  const wantShots = process.argv.includes('--shots');
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
    ],
  });

  try {
    await mobile(browser, origin, wantShots);
    await desktop(browser, origin, wantShots);
    await directLink(browser, origin);
    await keyboard(browser, origin);
    await withoutTheBasemap(browser, origin, wantShots);
  } finally {
    await browser.close();
  }

  // A second browser with WebGL off: the forecast has to survive a map that cannot draw.
  const blind = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-3d-apis'],
  });
  try {
    await withoutTheMap(blind, origin, wantShots);
  } finally {
    await blind.close();
    server.close();
  }

  for (const note of notes) console.log(`  ${note}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log('\nall smoke checks passed');
}

async function open(browser, origin, path, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('.hero-number', { timeout: 15000 });
  return { page, errors };
}

/**
 * The band drawn under the selected place against the class its own value falls in.
 *
 * Exact agreement is only required when the value sits clear of a class break. Contours
 * are interpolated between cell centers while the card samples one cell, so at a value a
 * third of a degree above a break the boundary genuinely runs through the reference
 * point and either side is correct. Demanding an exact match there tests the contouring
 * method rather than the interface. What must never happen is the map being two or more
 * classes away, which means it is drawing another hour.
 */
async function checkBandAgreement(page, when) {
  const read = () =>
    page.evaluate(() => {
      const { bundle, map, store } = window.feelslike;
      const { selection, hour } = store.current;
      const point = bundle.placeCells.places[selection.slug].reference_point;
      const value = bundle.cells.get(selection.cellId).apparent_temperature_f[hour];
      const band = bundle.manifest.display.bands.find(
        (entry) =>
          (entry.lower_f === null || value >= entry.lower_f) &&
          (entry.upper_f === null || value < entry.upper_f),
      );
      const edge = Math.min(
        band.lower_f === null ? Infinity : value - band.lower_f,
        band.upper_f === null ? Infinity : band.upper_f - value,
      );
      return { drawn: map.bandAt(point[0], point[1]), expected: band.band_id, value, edge };
    });

  // A new hour means fetching and parsing a frame, so poll rather than read once.
  let state = await read();
  const settled = () => {
    const gap = state.drawn === null ? Infinity : Math.abs(state.drawn - state.expected);
    return gap <= (state.edge < 1 ? 1 : 0);
  };
  for (let attempt = 0; attempt < 40 && !settled(); attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    state = await read();
  }

  check(
    settled(),
    `${when}, the map draws band ${state.drawn} where ${state.value}° belongs in band ${state.expected}`,
  );
  notes.push(
    `map band ${when}: ${state.drawn} for ${state.value}°, expected ${state.expected}` +
      (state.edge < 1 ? ` (within ${state.edge.toFixed(2)}° of a break)` : ''),
  );
}

async function mobile(browser, origin, wantShots) {
  const { page, errors } = await open(browser, origin, '/', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const hero = await page.$eval('#hero', (node) => ({
    place: node.querySelector('.place-name')?.textContent?.trim(),
    value: node.querySelector('.hero-number')?.textContent?.trim(),
    hour: node.querySelector('.hero-hour')?.textContent?.trim(),
  }));
  check(hero.value?.endsWith('°'), `hero shows no temperature: ${hero.value}`);
  notes.push(`mobile hero: ${hero.place} ${hero.value} at ${hero.hour}`);

  // Horizontal overflow is the classic mobile break, and it is invisible on desktop.
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 5)
      .map((node) => `${node.tagName.toLowerCase()}.${node.className}`),
  }));
  check(
    overflow.scroll <= overflow.client + 1,
    `page scrolls sideways at 390px: ${overflow.scroll} > ${overflow.client}, from ${overflow.wide.join(', ')}`,
  );

  // A map can start, size itself and report nothing wrong while drawing nothing, so ask
  // it what it rendered rather than trusting that it did.
  check(await page.$('.mapboxgl-canvas'), 'the map canvas never appeared');
  await page.waitForFunction(() => (window.feelslike?.map?.drawn().bands ?? 0) > 0, {
    timeout: 15000,
  });
  // The outlines are deliberately loaded last, so give them their moment before asking.
  await page
    .waitForFunction(() => (window.feelslike?.map?.drawn().selected ?? 0) > 0, { timeout: 15000 })
    .catch(() => undefined);

  const drawn = await page.evaluate(() => window.feelslike.map.drawn());
  check(drawn.bands > 0, 'the map drew no temperature bands');
  check(drawn.selected > 0, 'the selected place was never outlined on the map');
  check(drawn.basemap, 'the basemap never loaded');
  notes.push(`map drew ${drawn.bands} band shapes and ${drawn.selected} selected outline parts`);

  await checkBandAgreement(page, 'on load');

  // With a basemap the context labels come from Mapbox and ours stay hidden. The one
  // label that is always ours is the selected place, which no basemap can know about.
  await page
    .waitForFunction(() => document.querySelector('.map-label.selected:not([hidden])'), {
      timeout: 10000,
    })
    .catch(() => undefined);
  const label = await page.$eval(
    '.map-label.selected',
    (node) => (node.hidden ? '' : node.textContent.trim()),
  );
  check(label.length > 0, 'the selected place was never labeled on the map');
  const context = await page.$$eval('.map-label:not(.selected):not([hidden])', (n) => n.length);
  check(context === 0, `${context} of our own context labels drew over the basemap's`);
  notes.push(`map labels the selection "${label}", context labels from the basemap`);

  const legend = await page.$$eval('.legend-swatch', (nodes) => nodes.length);
  check(legend > 10, `legend has ${legend} classes`);

  // No Map/Chart tab switch anymore — both are discoverable on a normal scroll, the
  // chart before the map in reading order.
  await page.waitForSelector('#chart svg', { timeout: 10000 });
  const order = await page.evaluate(() => {
    const chart = document.querySelector('.chart-panel');
    const map = document.querySelector('.map-panel');
    return chart && map ? chart.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  check(order > 0, 'the chart does not precede the map in reading order');
  notes.push('chart and map both discoverable without a tab switch');

  if (wantShots) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'mobile.png'), fullPage: true });
  }

  check(errors.length === 0, `console errors on mobile: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

async function desktop(browser, origin, wantShots) {
  const { page, errors } = await open(browser, origin, '/', { width: 1024, height: 900 });

  // Scrubbing has to move every number on the page, not just the map.
  const before = await page.$eval('.hero-number', (node) => node.textContent);
  const hourBefore = await page.$eval('.hero-hour', (node) => node.textContent);
  await page.$eval('#hour', (input) => {
    input.value = '20';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const after = await page.$eval('.hero-number', (node) => node.textContent);
  const hourAfter = await page.$eval('.hero-hour', (node) => node.textContent);
  check(hourBefore !== hourAfter, 'the slider did not change the card hour');
  notes.push(`scrub: ${hourBefore} ${before} to ${hourAfter} ${after}`);

  const readout = await page.$eval('#hour-readout', (node) => node.textContent?.trim());
  check(readout === hourAfter?.trim(), `slider readout ${readout} disagrees with the card ${hourAfter}`);

  // The map has to follow the scrub too. A frame that arrives late, or an hour whose
  // frame quietly failed, would leave the map showing a different time than the card.
  await checkBandAgreement(page, 'after scrubbing');

  // A comparison has to read at the same hour as the card.
  await page.click('.suggestion');
  await page.waitForSelector('.compare-result:not([hidden]) .compare-result-diff', { timeout: 10000 });
  const compare = await page.$eval('.compare-result-diff', (node) => node.textContent.trim());
  check(
    compare.includes(hourAfter.trim()),
    `comparison does not name the selected hour: ${compare.slice(0, 90)}`,
  );
  notes.push(`comparison: ${compare.replace(/\s+/g, ' ').slice(0, 100)}`);

  if (wantShots) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'desktop.png'), fullPage: true });
  }

  check(errors.length === 0, `console errors on desktop: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

async function directLink(browser, origin) {
  const { page, errors } = await open(browser, origin, '/santa-monica?compare=lancaster', {
    width: 390,
    height: 844,
  });
  const place = await page.$eval('.place-name', (node) => node.textContent.trim());
  check(place === 'Santa Monica', `/santa-monica showed ${place}`);
  const compare = await page.$eval('#compare-place', (node) => node.value);
  check(compare === 'Lancaster', `?compare=lancaster showed ${compare}`);
  notes.push(`direct link: ${place} against ${compare}`);

  const nonsense = await browser.newPage();
  await nonsense.goto(`${origin}/not-a-place`, { waitUntil: 'networkidle0' });
  await nonsense.waitForSelector('.hero-number');
  const fallback = await nonsense.$eval('.place-name', (node) => node.textContent.trim());
  const explained = await nonsense.$eval('#locate-status', (node) => node.textContent.trim());
  check(fallback === 'Downtown', `an unknown place fell back to ${fallback}`);
  check(explained.length > 0, 'an unknown place gave no explanation');
  notes.push(`unknown slug: ${fallback}, saying "${explained}"`);
  await nonsense.close();

  check(errors.length === 0, `console errors on a direct link: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

/**
 * Mapbox unreachable: a dead token, a blocked domain, an outage.
 *
 * The temperatures come from files this build published, so the map has no business
 * disappearing when a tile provider does. It should fall back to its own geometry and
 * bring back the curated labels the basemap had been supplying.
 */
async function withoutTheBasemap(browser, origin, wantShots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  let blocked = 0;
  page.on('request', (request) => {
    if (request.url().includes('mapbox.com')) {
      blocked += 1;
      void request.abort();
    } else {
      void request.continue();
    }
  });

  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.hero-number', { timeout: 15000 });

  const value = await page.$eval('.hero-number', (node) => node.textContent.trim());
  check(value.endsWith('°'), `no temperature with Mapbox blocked: ${value}`);

  await page
    .waitForFunction(
      () => {
        const drawn = window.feelslike?.map?.drawn();
        return drawn && drawn.bands > 0 && !drawn.basemap;
      },
      { timeout: 20000 },
    )
    .catch(() => undefined);

  const drawn = await page.evaluate(() => window.feelslike?.map?.drawn() ?? null);
  check(drawn?.bands > 0, 'with Mapbox blocked the map drew no temperature bands');
  check(drawn?.basemap === false, 'the map claimed a basemap it could not load');

  // Our labels come back, because now nothing else is naming the places.
  await page.waitForFunction(
    () => document.querySelectorAll('.map-label:not([hidden])').length >= 3,
    { timeout: 10000 },
  );
  const labels = await page.$$eval('.map-label:not([hidden])', (nodes) => nodes.length);
  check(labels >= 3, `only ${labels} labels on the map without a basemap`);
  notes.push(`Mapbox blocked (${blocked} requests): ${drawn?.bands} bands, ${labels} own labels`);

  if (wantShots) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'no-basemap.png'), fullPage: true });
  }
  await page.close();
}

/** With no WebGL the map is impossible; every number still has to be there. */
async function withoutTheMap(browser, origin, wantShots) {
  const { page, errors } = await open(browser, origin, '/pasadena', { width: 390, height: 844 });

  const value = await page.$eval('.hero-number', (node) => node.textContent.trim());
  check(value.endsWith('°'), `no temperature without a map: ${value}`);
  check(await page.$('#chart svg'), 'the chart is missing without a map');
  check(await page.$('#hour'), 'the slider is missing without a map');

  const fallback = await page.$eval('.map-fallback', (node) => node.textContent.trim());
  check(fallback.length > 0, 'a failed map left no explanation');
  check(!(await page.$('.mapboxgl-canvas')), 'a map canvas appeared with WebGL disabled');
  notes.push(`without WebGL: Pasadena ${value}, map says "${fallback.slice(0, 60)}…"`);

  if (wantShots) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'no-map.png'), fullPage: true });
  }

  check(errors.length === 0, `console errors without a map: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

async function keyboard(browser, origin) {
  const { page, errors } = await open(browser, origin, '/', { width: 1024, height: 900 });

  // Search by keyboard alone: type, arrow down, Enter.
  await page.focus('#place-search');
  await page.type('#place-search', 'lancast');
  await page.waitForSelector('.picker-option');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.place-name')?.textContent?.trim() === 'Lancaster',
    { timeout: 5000 },
  );
  notes.push('keyboard search reached Lancaster');

  // Lancaster is in the Antelope Valley, outside the opening LA frame. The map has to go
  // and get it, or the reader is told about a highlighted outline they cannot see.
  const reached = await page
    .waitForFunction(
      () => {
        const { bundle, map } = window.feelslike;
        const [longitude, latitude] = bundle.placeCells.places.lancaster.reference_point;
        return map.bandAt(longitude, latitude) !== null;
      },
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  check(reached, 'selecting Lancaster left it outside the map view');
  check(await page.$('.map-reset:not([hidden])'), 'no way back to the LA view after panning');

  await page.click('.map-reset');
  const home = await page
    .waitForFunction(
      () => {
        const { bundle, map } = window.feelslike;
        const [longitude, latitude] = bundle.placeCells.places.downtown.reference_point;
        return map.bandAt(longitude, latitude) !== null;
      },
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  check(home, 'reset did not return to the LA view');
  notes.push('map panned to Lancaster and reset back to LA');

  // The slider moves with arrow keys.
  await page.focus('#hour');
  const start = await page.$eval('#hour', (input) => input.value);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const moved = await page.$eval('#hour', (input) => input.value);
  check(Number(moved) === Number(start) + 2, `arrow keys moved the slider ${start} to ${moved}`);

  const described = await page.$eval('#hour', (input) => input.getAttribute('aria-valuetext'));
  check(Boolean(described?.match(/[ap]\.m\./)), `slider announces "${described}"`);
  notes.push(`slider announces "${described}"`);

  check(errors.length === 0, `console errors during keyboard use: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

await main();
