// Generates public/apple-touch-icon.png and public/og-image.png.
//
//   npm run brand
//
// The OG card used to render live spread data ("A 20° spread across LA County right
// now"), but nothing regenerates it as forecasts change, so it just went stale — a
// share card is worse than useless if it's making a claim that's since become false.
// It's static and evergreen now: logo, tagline, and an illustrative (not live) gradient
// bar. Re-run only if the design itself changes.
//
// Uses the Chrome already on the machine, the same way scripts/smoke.mjs does, rather
// than pulling in a headless-rendering dependency for two images.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SCALE_GRADIENT =
  'linear-gradient(to right, #5e4fa2, #4192b9, #66c2a5, #abdda4, #e6f598, #fee08b, #f98d51, #d53e4f, #9e0142)';

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

function ogHtml() {
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
              What it feels like across Los Angeles County
            </p>
          </div>
          <div>
            <div style="position:relative;height:22px;border-radius:999px;
              box-shadow:0 0 0 1px rgba(255,255,255,0.18);background-image:${SCALE_GRADIENT};margin-bottom:26px;">
            </div>
            <div style="display:flex;justify-content:space-between;font-size:26px;font-weight:700;">
              <span>Cooler near the coast</span>
              <span>Hotter inland</span>
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
    await og.setContent(ogHtml());
    await og.screenshot({ path: join(OUT, 'og-image.png') });
    await og.close();
  } finally {
    await browser.close();
  }

  console.log('wrote apple-touch-icon.png and og-image.png');
}

await main();
