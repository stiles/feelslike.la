// Generates public/apple-touch-icon.png and public/og-image.png.
//
//   npm run brand
//
// The OG card is real, not a mockup: it reads whatever build public/data currently
// points at and shows the actual county-wide spread at generation time, using the same
// band colors as the map and the in-app spread gauge. Re-run this after a notable
// forecast, or wire it into deploy if the card should always be current.
//
// Uses the Chrome already on the machine, the same way scripts/smoke.mjs does, rather
// than pulling in a headless-rendering dependency for two images.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
const OUT = join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadSpread() {
  const latest = await readJson(join(DATA, 'latest.json'));
  const buildDir = join(DATA, dirname(latest.manifest));
  const manifest = await readJson(join(buildDir, 'manifest.json'));
  const places = await readJson(join(buildDir, 'places.json'));
  const placeCells = await readJson(join(buildDir, 'place_cells.json'));
  const cellForecasts = await readJson(join(buildDir, 'cell_forecasts.json'));

  const cells = new Map(cellForecasts.cells.map((cell) => [cell.cell_id, cell]));
  let cool = null;
  let hot = null;
  for (const place of places.places) {
    const cellId = placeCells.places[place.slug]?.cell_id;
    const value = cellId ? cells.get(cellId)?.apparent_temperature_f?.[0] ?? null : null;
    if (value === null) continue;
    if (!cool || value < cool.value) cool = { name: place.name, value };
    if (!hot || value > hot.value) hot = { name: place.name, value };
  }

  return { manifest, cool, hot };
}

function gradient(bands, low, high) {
  const span = high - low;
  const stops = [];
  for (const band of bands) {
    const lower = band.lower_f ?? low;
    const upper = band.upper_f ?? high;
    const start = Math.max(0, Math.min(100, ((lower - low) / span) * 100));
    const end = Math.max(0, Math.min(100, ((upper - low) / span) * 100));
    if (end <= start) continue;
    stops.push(`${band.color} ${start}%`, `${band.color} ${end}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function iconHtml() {
  return `
    <html><body style="margin:0">
      <div style="width:180px;height:180px;border-radius:40px;overflow:hidden;
        background:linear-gradient(135deg,#4192b9 0%,#e5f598 38%,#f98d51 70%,#9e0142 100%);
        display:flex;align-items:center;justify-content:center;font-family:sans-serif;">
        <div style="width:76px;height:76px;border-radius:50%;background:#171717;
          display:flex;align-items:center;justify-content:center;">
          <div style="width:26px;height:26px;border-radius:50%;background:#fff;"></div>
        </div>
      </div>
    </body></html>
  `;
}

function ogHtml({ manifest, cool, hot }) {
  const bands = manifest.display.bands;
  const breaks = manifest.band_breaks_f;
  const low = breaks[0] - 8;
  const high = breaks[breaks.length - 1] + 8;
  const track = gradient(bands, low, high);
  const gap = cool && hot ? Math.round(hot.value) - Math.round(cool.value) : null;

  return `
    <html>
      <head>
        <style>
          @font-face { font-family: 'Roboto'; src: local('Roboto'); }
          * { box-sizing: border-box; }
          body { margin: 0; font-family: Roboto, -apple-system, sans-serif; }
        </style>
      </head>
      <body>
        <div style="width:1200px;height:630px;background:#171717;color:#fff;
          padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;">
          <div>
            <p style="margin:0;font-size:22px;font-weight:500;letter-spacing:0.06em;
              text-transform:uppercase;color:rgba(255,255,255,0.6);">Feels like <strong style="color:#fff;">LA</strong></p>
            <p style="margin:22px 0 0;font-size:40px;font-weight:700;line-height:1.2;max-width:980px;">
              ${gap !== null ? `A ${gap}&deg; spread across Los Angeles County right now` : 'What it feels like across Los Angeles County'}
            </p>
          </div>
          <div>
            <div style="position:relative;height:22px;border-radius:999px;
              box-shadow:0 0 0 1px rgba(255,255,255,0.18);background-image:${track};margin-bottom:26px;">
            </div>
            <div style="display:flex;justify-content:space-between;font-size:26px;font-weight:700;">
              <span>${cool ? `${cool.name} ${Math.round(cool.value)}°` : ''}</span>
              <span>${hot ? `${hot.name} ${Math.round(hot.value)}°` : ''}</span>
            </div>
            <p style="margin:28px 0 0;font-size:20px;color:rgba(255,255,255,0.68);">
              Hourly apparent-temperature forecasts from the National Weather Service · feelslike.la
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
}

async function main() {
  const spread = await loadSpread();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--hide-scrollbars'],
  });

  try {
    const icon = await browser.newPage();
    await icon.setViewport({ width: 180, height: 180, deviceScaleFactor: 2 });
    await icon.setContent(iconHtml());
    await icon.screenshot({ path: join(OUT, 'apple-touch-icon.png') });
    await icon.close();

    const og = await browser.newPage();
    await og.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
    await og.setContent(ogHtml(spread));
    await og.screenshot({ path: join(OUT, 'og-image.png') });
    await og.close();
  } finally {
    await browser.close();
  }

  console.log(
    `wrote apple-touch-icon.png and og-image.png` +
      (spread.cool && spread.hot
        ? ` (${spread.cool.name} ${Math.round(spread.cool.value)}° to ${spread.hot.name} ${Math.round(spread.hot.value)}°)`
        : ''),
  );
}

await main();
