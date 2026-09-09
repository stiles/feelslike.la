// Generates public/apple-touch-icon.png, the production OG card, and concept variants.
//
//   npm run brand
//
// The production OG card stays evergreen because nothing regenerates it as forecasts
// change. The concept cards below are design explorations for future iterations: they
// borrow more of the product's composition and palette without becoming live claims.
//
// Uses the Chrome already on the machine, the same way scripts/smoke.mjs does, rather
// than pulling in a headless-rendering dependency for a few static images.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPO_ROOT = resolve(ROOT, '..');
const BUILD_ROOT = join(REPO_ROOT, 'build');
const LATEST_POINTER = join(BUILD_ROOT, 'latest.json');
const MAPBOX_GL_JS = join(ROOT, 'node_modules/mapbox-gl/dist/mapbox-gl.js');
const MAPBOX_GL_CSS = join(ROOT, 'node_modules/mapbox-gl/dist/mapbox-gl.css');
const DEFAULT_MAPBOX_STYLE = 'mapbox://styles/stiles/cmiuh91nz003q01su2wd5b64l';

const VIEWPORT = { width: 1200, height: 630, deviceScaleFactor: 2 };

const SCALE_GRADIENT =
  'linear-gradient(90deg, #5e4fa2 0%, #4b73b3 10%, #4192b9 18%, #5aaeae 28%, #7dcaa5 38%, #b7e2a2 48%, #e5f598 58%, #ffffbf 66%, #fee18d 74%, #feb869 82%, #f98d51 89%, #eb6047 94%, #ce394e 97%, #9e0142 100%)';

function localEnv(name) {
  try {
    const contents = readFileSync(join(ROOT, '.env'), 'utf8');
    const line = contents.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
  } catch {
    return '';
  }
}

function shell(content, extraCss = '') {
  return `
    <html>
      <head>
        <style>
          * { box-sizing: border-box; }
          :root {
            color-scheme: light;
            --ink: #181716;
            --muted: rgba(24, 23, 22, 0.64);
            --paper: #f5f1eb;
            --line: rgba(24, 23, 22, 0.12);
            --warm-panel: linear-gradient(135deg, #8f4436 0%, #532920 34%, #1a1918 100%);
          }
          body {
            margin: 0;
            font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: transparent;
          }
          .eyebrow {
            margin: 0 0 16px;
            font-size: 19px;
            font-weight: 700;
            letter-spacing: 0.12em;
            text-transform: uppercase;
          }
          .small {
            font-size: 20px;
            line-height: 1.35;
          }
          .muted { color: rgba(255, 255, 255, 0.72); }
          ${extraCss}
        </style>
      </head>
      <body>${content}</body>
    </html>
  `;
}

function latestBuildDir() {
  const pointer = JSON.parse(readFileSync(LATEST_POINTER, 'utf8'));
  return join(BUILD_ROOT, pointer.manifest.replace(/\/manifest\.json$/, ''));
}

function loadPublishedMapData() {
  const buildDir = latestBuildDir();
  const manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
  const places = JSON.parse(readFileSync(join(buildDir, 'places.json'), 'utf8'));

  const placeBySlug = new Map(places.places.map((place) => [place.slug, place]));
  const labels = (manifest.display?.label_places ?? [])
    .map((slug) => placeBySlug.get(slug))
    .filter(Boolean);

  return { labels };
}

function mapPoint(longitude, latitude) {
  const bounds = { west: -119, east: -117.4, north: 34.38, south: 33.68 };
  const x = ((longitude - bounds.west) / (bounds.east - bounds.west)) * 1200;
  const y = ((bounds.north - latitude) / (bounds.north - bounds.south)) * 630;
  return { x, y };
}

function mapPath(coordinates, { close = false } = {}) {
  const path = coordinates
    .map(([longitude, latitude], index) => {
      const point = mapPoint(longitude, latitude);
      return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(' ');
  return close ? `${path} Z` : path;
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

function contourMap({
  width = 760,
  height = 630,
  showLabels = true,
  crop = 'wide',
  richLabels = false,
} = {}) {
  const labelLayer = showLabels
    ? `
      <text x="476" y="306" class="map-label major">Los Angeles</text>
      <text x="346" y="196" class="map-label">Burbank</text>
      <text x="430" y="230" class="map-label">Glendale</text>
      <text x="162" y="338" class="map-label">Santa Monica</text>
      <text x="260" y="444" class="map-label">Inglewood</text>
      <text x="430" y="466" class="map-label">Compton</text>
      <text x="574" y="430" class="map-label">Downey</text>
      <text x="236" y="500" class="map-label">Hawthorne</text>
      ${
        richLabels
          ? `
        <text x="514" y="264" class="map-label minor">Pasadena</text>
        <text x="614" y="284" class="map-label minor">Arcadia</text>
        <text x="632" y="334" class="map-label minor">El Monte</text>
        <text x="626" y="520" class="map-label minor">Norwalk</text>
        <text x="188" y="558" class="map-label minor">Torrance</text>
        <text x="128" y="404" class="map-label minor">Long Beach</text>
      `
          : ''
      }
    `
    : '';

  const marker =
    crop === 'close'
      ? `
      <g transform="translate(238 358)">
        <path d="M0 0 C 8 -18 28 -28 48 -28 C 68 -28 84 -16 84 2 C 84 24 62 42 42 61 C 21 44 0 25 0 0 Z"
          fill="#fffaf1" stroke="rgba(24,23,22,0.14)" stroke-width="2"/>
        <circle cx="21" cy="15" r="7" fill="#181716"/>
        <text x="36" y="21" font-size="18" font-weight="700" fill="#181716">Del Rey</text>
      </g>
    `
      : '';

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 760 630" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="warm-wash" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="38%" stop-color="#f7d7a5"/>
          <stop offset="70%" stop-color="#f18f67"/>
          <stop offset="100%" stop-color="#8c1f53"/>
        </linearGradient>
        <filter id="paper-noise" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="2" stitchTiles="stitch"/>
          <feColorMatrix type="saturate" values="0"/>
          <feComponentTransfer>
            <feFuncA type="table" tableValues="0 0.035"/>
          </feComponentTransfer>
        </filter>
      </defs>
      <rect width="760" height="630" fill="#f3efe9"/>
      <rect width="760" height="630" fill="url(#warm-wash)" opacity="0.24"/>
      <g opacity="0.92">
        <path d="M-20 0 H760 V120 C700 132 612 146 544 186 C503 209 454 242 418 279 C367 332 336 403 286 456 C252 492 212 523 181 560 C162 583 145 607 134 630 H-20 Z" fill="#fff3ca"/>
        <path d="M-20 84 C78 64 126 74 188 106 C244 135 299 151 346 145 C420 135 488 162 532 202 C586 250 660 254 760 238 V630 H-20 Z" fill="#fee6ad"/>
        <path d="M-20 166 C73 153 132 169 184 220 C226 261 284 275 344 263 C402 251 447 268 492 309 C540 353 640 378 760 334 V630 H-20 Z" fill="#fec78f"/>
        <path d="M-20 237 C88 212 148 256 215 302 C273 342 349 349 417 335 C482 322 532 341 603 393 C645 424 698 436 760 430 V630 H-20 Z" fill="#fb9c6e"/>
        <path d="M-20 312 C71 283 162 321 233 366 C289 401 357 416 430 398 C501 381 573 401 625 445 C670 483 713 501 760 506 V630 H-20 Z" fill="#ea6a66"/>
        <path d="M-20 368 C54 345 130 383 199 430 C262 472 331 496 411 474 C490 453 576 466 631 510 C671 542 712 560 760 574 V630 H-20 Z" fill="#cf5b88"/>
        <path d="M-20 430 C54 414 116 459 185 505 C246 545 312 566 396 548 C478 531 556 542 613 576 C642 593 691 612 760 617 V630 H-20 Z" fill="#ad4f8b"/>
      </g>
      <g opacity="0.5">
        <path d="M0 214 C70 192 116 215 164 250 C206 280 263 289 319 281 C370 273 405 281 447 317" fill="none" stroke="rgba(113,84,73,0.32)" stroke-width="5"/>
        <path d="M182 126 C250 136 317 137 375 160 C439 186 493 230 543 295" fill="none" stroke="rgba(113,84,73,0.24)" stroke-width="4"/>
        <path d="M341 236 C385 268 409 316 420 388 C429 444 454 499 502 560" fill="none" stroke="rgba(113,84,73,0.28)" stroke-width="4"/>
        <path d="M540 270 C585 284 614 314 629 369 C644 426 666 467 706 511" fill="none" stroke="rgba(113,84,73,0.25)" stroke-width="4"/>
      </g>
      <path d="M96 143 C117 190 127 247 126 304 C125 362 146 417 190 493 C226 555 248 594 244 630" fill="#d2d2d2"/>
      <path d="M96 143 C117 190 127 247 126 304 C125 362 146 417 190 493 C226 555 248 594 244 630" fill="none" stroke="rgba(93,93,93,0.45)" stroke-width="2"/>
      <path d="M112 186 C178 178 250 212 312 260 C362 298 413 315 472 307 C549 295 623 310 675 356 C710 387 734 435 760 496" fill="none" stroke="rgba(84,61,56,0.16)" stroke-width="10"/>
      <rect width="760" height="630" filter="url(#paper-noise)" opacity="0.7"/>
      ${labelLayer}
      ${marker}
    </svg>
  `;
}

function realisticCountyMap() {
  const { labels } = loadPublishedMapData();
  const coastline = [
    [-119.03, 34.11],
    [-118.91, 34.09],
    [-118.79, 34.03],
    [-118.66, 34.04],
    [-118.52, 34.03],
    [-118.48, 34.0],
    [-118.46, 33.96],
    [-118.43, 33.91],
    [-118.4, 33.86],
    [-118.42, 33.8],
    [-118.37, 33.74],
    [-118.3, 33.7],
    [-118.25, 33.72],
    [-118.2, 33.74],
    [-118.13, 33.75],
    [-118.08, 33.7],
    [-118.02, 33.64],
  ];
  const coastPath = mapPath(coastline);
  const oceanPath = `${coastPath} L735 630 L0 630 Z`;
  const landPath = `${coastPath} L1200 630 L1200 0 L0 0 Z`;
  const countyPath = landPath;

  const roads = [
    [[-118.66, 34.16], [-118.55, 34.17], [-118.43, 34.15], [-118.34, 34.1], [-118.25, 34.05]],
    [[-118.5, 34.02], [-118.39, 34.04], [-118.25, 34.05], [-118.14, 34.03], [-117.98, 34.05], [-117.78, 34.06]],
    [[-118.54, 34.39], [-118.47, 34.3], [-118.37, 34.24], [-118.31, 34.18], [-118.25, 34.05], [-118.16, 33.96], [-118.08, 33.9], [-118.01, 33.82]],
    [[-118.47, 34.31], [-118.48, 34.2], [-118.44, 34.08], [-118.4, 33.94], [-118.31, 33.84], [-118.19, 33.77]],
    [[-118.25, 34.05], [-118.28, 33.98], [-118.28, 33.89], [-118.29, 33.79], [-118.27, 33.72]],
    [[-118.17, 34.06], [-118.16, 33.98], [-118.15, 33.89], [-118.17, 33.81], [-118.19, 33.77]],
    [[-118.4, 33.94], [-118.29, 33.94], [-118.18, 33.93], [-118.08, 33.92]],
    [[-118.08, 34.24], [-118.09, 34.13], [-118.09, 34.02], [-118.08, 33.92], [-118.09, 33.8]],
  ];
  const roadMarkup = roads
    .map(
      (road, index) => `
        <path d="${mapPath(road)}" class="road-casing" />
        <path d="${mapPath(road)}" class="road-line${index < 4 ? ' freeway' : ''}" />
      `,
    )
    .join('');

  const labelMarkup = labels
    .map((place) => {
      const point = mapPoint(place.reference_point.longitude, place.reference_point.latitude);
      if (point.x < 430 || point.x > 1160 || point.y < 30 || point.y > 595) return '';
      const isMajor = ['Pasadena', 'Downtown', 'Long Beach'].includes(place.name);
      const fontSize = isMajor ? 23 : 16;
      const fontWeight = isMajor ? 750 : 600;
      return `
        <text
          x="${point.x.toFixed(1)}"
          y="${point.y.toFixed(1)}"
          class="county-label${isMajor ? ' major' : ''}"
          text-anchor="middle"
          dominant-baseline="middle"
          font-size="${fontSize}"
          font-weight="${fontWeight}"
          fill="rgba(45, 40, 36, 0.8)"
          stroke="rgba(250, 244, 228, 0.86)"
          stroke-width="3.2"
          paint-order="stroke fill"
        >${place.name}</text>
      `;
    })
    .join('');

  return `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="map-sky" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#aeb8ac"/>
          <stop offset="42%" stop-color="#ddd8c4"/>
          <stop offset="100%" stop-color="#ead8bd"/>
        </linearGradient>
        <linearGradient id="county-fill" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#f7f0df"/>
          <stop offset="42%" stop-color="#f8efd1"/>
          <stop offset="70%" stop-color="#f6e0b4"/>
          <stop offset="100%" stop-color="#f2c39d"/>
        </linearGradient>
        <linearGradient id="ocean-fill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#71888a"/>
          <stop offset="54%" stop-color="#93a6a4"/>
          <stop offset="100%" stop-color="#c3c7b9"/>
        </linearGradient>
        <filter id="grain" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="table" tableValues="0 0.05" />
          </feComponentTransfer>
        </filter>
        <clipPath id="county-clip">
          <path d="${countyPath}" />
        </clipPath>
      </defs>

      <rect width="1200" height="630" fill="url(#map-sky)" />

      <g opacity="0.9">
        <ellipse cx="106" cy="468" rx="298" ry="272" fill="url(#ocean-fill)" opacity="0.52" />
        <ellipse cx="118" cy="548" rx="160" ry="122" fill="#d6ddd6" opacity="0.2" />
        <ellipse cx="992" cy="112" rx="430" ry="170" fill="#f8eab7" opacity="0.32" />
        <ellipse cx="1004" cy="492" rx="250" ry="150" fill="#f2cf91" opacity="0.18" />
      </g>

      <path
        d="${countyPath}"
        fill="url(#county-fill)"
        opacity="0.86"
        fill-rule="evenodd"
        stroke="rgba(27, 24, 21, 0.6)"
        stroke-width="1.6"
        vector-effect="non-scaling-stroke"
      />

      <g clip-path="url(#county-clip)">
        <g opacity="0.95">
          <path d="M38 128 C172 109 268 135 370 191 C470 246 561 248 661 219 C761 189 844 201 930 249 C1016 297 1094 301 1192 257"
            fill="none" stroke="rgba(255, 242, 178, 0.62)" stroke-width="76" stroke-linecap="round" />
          <path d="M38 188 C161 167 255 183 347 231 C441 280 539 287 629 267 C722 246 812 259 902 312 C988 363 1086 371 1192 334"
            fill="none" stroke="rgba(255, 196, 126, 0.64)" stroke-width="74" stroke-linecap="round" />
          <path d="M38 246 C170 223 273 251 367 301 C456 347 546 357 635 340 C724 323 811 335 893 382 C977 430 1081 441 1192 418"
            fill="none" stroke="rgba(247, 140, 93, 0.55)" stroke-width="74" stroke-linecap="round" />
          <path d="M38 315 C166 291 264 317 351 367 C441 419 525 435 608 417 C696 397 791 404 873 451 C952 496 1057 515 1192 506"
            fill="none" stroke="rgba(225, 89, 106, 0.52)" stroke-width="74" stroke-linecap="round" />
          <path d="M38 385 C164 358 247 390 333 444 C417 496 496 522 574 508 C654 494 741 496 821 534 C900 571 1012 590 1192 593"
            fill="none" stroke="rgba(184, 70, 123, 0.54)" stroke-width="74" stroke-linecap="round" />
        </g>

        <g opacity="0.38" stroke="rgba(95, 68, 59, 0.42)" stroke-width="4.8" fill="none" stroke-linecap="round">
          <path d="M118 172 C152 252 160 318 156 384 C152 450 181 512 236 583" />
          <path d="M296 96 C372 111 452 126 521 156 C593 187 655 231 707 290" />
          <path d="M462 202 C528 237 563 286 574 358 C584 428 611 491 660 558" />
          <path d="M744 212 C805 241 846 289 862 356 C878 421 908 473 956 526" />
          <path d="M967 286 C1012 321 1040 370 1053 429 C1067 489 1095 536 1141 582" />
        </g>

        <g class="roads">${roadMarkup}</g>
        <rect width="1200" height="630" filter="url(#grain)" opacity="0.62" />
      </g>

      <path d="${oceanPath}" fill="url(#ocean-fill)" />
      <path
        d="${coastPath}"
        fill="none"
        stroke="rgba(255, 246, 229, 0.76)"
        stroke-width="1.8"
        vector-effect="non-scaling-stroke"
      />

      ${labelMarkup}

      <style>
        .road-casing { fill: none; stroke: rgba(83, 73, 63, 0.16); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
        .road-line { fill: none; stroke: rgba(255, 250, 233, 0.55); stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; }
        .road-line.freeway { stroke-width: 1.8; stroke: rgba(255, 250, 233, 0.7); }
      </style>
    </svg>
  `;
}

function ogHtml() {
  return shell(`
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
  `);
}

function conceptMapPortrait() {
  return shell(
    `
      <div class="card map-portrait">
        <div class="topline">
          <div class="brand">Feels Like <strong>LA</strong></div>
          <div class="kicker">Local forecast</div>
        </div>
        <div class="content">
          <div class="copy">
            <p class="eyebrow portrait-eyebrow">Across the county</p>
            <h1>What it feels like across Los Angeles.</h1>
            <p class="deck">Hyperlocal apparent-temperature forecasts, updated hourly from the National Weather Service.</p>
          </div>
          <div class="map-frame">
            ${contourMap({ width: 690, height: 630, showLabels: true, crop: 'close' })}
          </div>
        </div>
      </div>
    `,
    `
      .card.map-portrait {
        width: 1200px;
        height: 630px;
        overflow: hidden;
        position: relative;
        color: var(--ink);
        background:
          radial-gradient(circle at 18% 18%, rgba(159, 56, 44, 0.18), transparent 38%),
          linear-gradient(180deg, #faf6ef 0%, #f3eee7 100%);
        padding: 34px 38px 0 42px;
      }
      .topline {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 16px;
        position: relative;
        z-index: 3;
      }
      .brand {
        font-size: 22px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        font-weight: 600;
      }
      .brand strong { font-weight: 800; }
      .kicker {
        color: var(--muted);
        font-size: 18px;
        font-weight: 500;
      }
      .content {
        display: grid;
        grid-template-columns: 410px 1fr;
        align-items: stretch;
      }
      .copy {
        position: relative;
        z-index: 3;
        padding-top: 36px;
      }
      .portrait-eyebrow { color: rgba(24, 23, 22, 0.48); }
      h1 {
        margin: 0;
        font-size: 66px;
        line-height: 0.98;
        letter-spacing: -0.045em;
        max-width: 360px;
      }
      .deck {
        margin: 24px 0 0;
        max-width: 320px;
        font-size: 26px;
        line-height: 1.25;
        color: rgba(24, 23, 22, 0.7);
      }
      .map-frame {
        position: relative;
        margin-left: -40px;
        margin-top: -30px;
      }
      .map-label {
        font-size: 18px;
        fill: rgba(39, 34, 31, 0.72);
        font-weight: 500;
        paint-order: stroke;
        stroke: rgba(255, 251, 244, 0.75);
        stroke-width: 4px;
      }
      .map-label.major {
        font-size: 26px;
        font-weight: 700;
      }
    `,
  );
}

function conceptSplitPanel() {
  return shell(
    `
      <div class="card split-card">
        <div class="left-panel">
          <p class="eyebrow muted">Feels Like Forecast</p>
          <h1>Los Angeles County</h1>
          <p class="time">Hourly apparent temperature, place by place.</p>
          <div class="chip-row">
            <div class="chip active">Neighborhoods</div>
            <div class="chip">Coast to inland</div>
          </div>
          <div class="scale">
            <div class="scale-bar"></div>
            <div class="scale-labels">
              <span>Coastal relief</span>
              <span>Valley heat</span>
            </div>
          </div>
          <p class="foot">National Weather Service data · feelslike.la</p>
        </div>
        <div class="right-panel">
          ${contourMap({ width: 742, height: 630, showLabels: true, crop: 'close' })}
        </div>
      </div>
    `,
    `
      .split-card {
        width: 1200px;
        height: 630px;
        display: grid;
        grid-template-columns: 404px 1fr;
        overflow: hidden;
        background: #eee7de;
      }
      .left-panel {
        color: #fffdf9;
        background:
          radial-gradient(circle at 24% 20%, rgba(255, 136, 91, 0.17), transparent 34%),
          linear-gradient(135deg, #8f4436 0%, #5e2f26 35%, #1a1918 100%);
        padding: 50px 42px 46px;
        display: flex;
        flex-direction: column;
      }
      .left-panel h1 {
        margin: 0;
        font-size: 60px;
        line-height: 0.96;
        letter-spacing: -0.05em;
      }
      .time {
        margin: 18px 0 0;
        font-size: 27px;
        line-height: 1.2;
        color: rgba(255, 251, 244, 0.82);
        max-width: 280px;
      }
      .chip-row {
        display: flex;
        gap: 12px;
        margin-top: 28px;
      }
      .chip {
        border: 1px solid rgba(255, 251, 244, 0.22);
        border-radius: 999px;
        padding: 10px 16px;
        font-size: 18px;
        color: rgba(255, 251, 244, 0.76);
        background: rgba(255, 255, 255, 0.04);
      }
      .chip.active {
        color: #181716;
        background: #fff7ee;
        border-color: transparent;
        font-weight: 700;
      }
      .scale {
        margin-top: auto;
        padding-top: 34px;
      }
      .scale-bar {
        height: 20px;
        border-radius: 999px;
        background-image: ${SCALE_GRADIENT};
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
      }
      .scale-labels {
        display: flex;
        justify-content: space-between;
        margin-top: 12px;
        font-size: 20px;
        font-weight: 700;
      }
      .foot {
        margin: 22px 0 0;
        font-size: 18px;
        line-height: 1.35;
        color: rgba(255, 251, 244, 0.65);
      }
      .right-panel {
        position: relative;
        overflow: hidden;
      }
      .right-panel svg {
        width: 830px;
        height: 690px;
        margin-left: -18px;
        margin-top: -12px;
      }
      .map-label {
        font-size: 18px;
        fill: rgba(39, 34, 31, 0.7);
        font-weight: 500;
        paint-order: stroke;
        stroke: rgba(255, 251, 244, 0.78);
        stroke-width: 4px;
      }
      .map-label.major {
        font-size: 28px;
        font-weight: 800;
      }
    `,
  );
}

function conceptSpotlight(basemapDataUrl = '') {
  return shell(
    `
      <div class="card spotlight-card">
        <div class="map-backdrop">
          ${
            basemapDataUrl
              ? `<img src="${basemapDataUrl}" alt="" />`
              : realisticCountyMap()
          }
        </div>
        <div class="forecast-wash"></div>
        <div class="left-panel"></div>
        <div class="map-glow"></div>
        <div class="headline-block">
          <p class="eyebrow spotlight-eyebrow">Feels Like LA</p>
          <h1>Beautifully local weather.</h1>
        </div>
        <p class="footer-copy">Hyperlocal apparent-temperature forecasts from the National Weather Service</p>
      </div>
    `,
    `
      .spotlight-card {
        width: 1200px;
        height: 630px;
        position: relative;
        overflow: hidden;
        color: #fffaf4;
        background: #181716;
      }
      .map-backdrop {
        position: absolute;
        inset: 0;
      }
      .map-backdrop svg {
        width: 1260px;
        height: 660px;
        margin-left: -14px;
        margin-top: -18px;
        filter: saturate(1.08) contrast(1.04) brightness(1.02);
      }
      .map-backdrop img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        filter: saturate(0.78) sepia(0.12) contrast(0.9) brightness(1.05);
      }
      .forecast-wash {
        position: absolute;
        inset: 0;
        opacity: ${basemapDataUrl ? 1 : 0};
        background:
          radial-gradient(ellipse 54% 62% at 94% 72%, rgba(194, 55, 96, 0.5), transparent 72%),
          radial-gradient(ellipse 48% 50% at 72% 35%, rgba(251, 181, 93, 0.42), transparent 76%),
          radial-gradient(ellipse 36% 56% at 40% 78%, rgba(74, 147, 178, 0.32), transparent 76%),
          linear-gradient(116deg, rgba(66, 146, 178, 0.16) 20%, rgba(255, 239, 151, 0.28) 54%, rgba(230, 91, 92, 0.34) 100%);
        mix-blend-mode: multiply;
      }
      .left-panel {
        position: absolute;
        inset: 0;
        background:
          linear-gradient(90deg, rgba(21, 19, 19, 0.99) 0%, rgba(21, 19, 19, 0.94) 19%, rgba(21, 19, 19, 0.7) 31%, rgba(21, 19, 19, 0.32) 42%, rgba(21, 19, 19, 0.08) 53%, rgba(21, 19, 19, 0) 64%),
          linear-gradient(180deg, rgba(21, 19, 19, 0.06), rgba(21, 19, 19, 0.34));
      }
      .map-glow {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 68% 28%, rgba(255, 245, 215, 0.12), transparent 24%),
          radial-gradient(circle at 70% 72%, rgba(248, 145, 87, 0.12), transparent 28%),
          linear-gradient(180deg, rgba(21, 19, 19, 0.02), rgba(21, 19, 19, 0.28));
      }
      .headline-block {
        position: relative;
        z-index: 2;
        width: 420px;
        padding: 54px 0 0 58px;
      }
      .spotlight-eyebrow { color: rgba(255, 250, 244, 0.72); }
      .headline-block h1 {
        margin: 0;
        font-size: 72px;
        line-height: 0.95;
        letter-spacing: -0.055em;
      }
      .footer-copy {
        position: absolute;
        left: 58px;
        bottom: 42px;
        z-index: 2;
        margin: 0;
        font-size: 18px;
        color: rgba(255, 250, 244, 0.72);
      }
      .county-label.major { letter-spacing: -0.02em; }
    `,
  );
}

function comparisonSheet(basemapDataUrl = '') {
  const cards = [
    {
      label: 'Concept 1 · Weather Portrait',
      body: conceptMapPortrait().match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '',
      css: conceptMapPortrait().match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '',
    },
    {
      label: 'Concept 2 · Split Product Card',
      body: conceptSplitPanel().match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '',
      css: conceptSplitPanel().match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '',
    },
    {
      label: 'Concept 3 · Editorial Spotlight',
      body: conceptSpotlight(basemapDataUrl).match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '',
      css: conceptSpotlight(basemapDataUrl).match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '',
    },
  ];

  return shell(
    `
      <div class="sheet">
        <header>
          <p class="meta">Feels Like LA share card exploration</p>
          <h1>Three directions to compare</h1>
        </header>
        ${cards
          .map(
            (card, index) => `
              <section class="option option-${index + 1}">
                <p class="label">${card.label}</p>
                <div class="preview scale-${index + 1}">
                  ${card.body}
                </div>
              </section>
            `,
          )
          .join('')}
      </div>
    `,
    `
      body {
        background: #ece6de;
        color: var(--ink);
      }
      .sheet {
        width: 1780px;
        padding: 48px;
      }
      header {
        margin-bottom: 28px;
      }
      .meta {
        margin: 0 0 10px;
        font-size: 18px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(24, 23, 22, 0.56);
        font-weight: 700;
      }
      header h1 {
        margin: 0;
        font-size: 44px;
        line-height: 1;
        letter-spacing: -0.04em;
      }
      .option + .option {
        margin-top: 30px;
      }
      .label {
        margin: 0 0 12px;
        font-size: 22px;
        font-weight: 800;
      }
      .preview {
        transform-origin: top left;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 18px 48px rgba(24, 23, 22, 0.08);
      }
      .scale-1, .scale-2, .scale-3 {
        transform: scale(0.56);
        margin-bottom: -277px;
      }
      ${cards.map((card) => card.css).join('\n')}
    `,
  );
}

async function screenshot(page, fileName, html, viewport = VIEWPORT) {
  await page.setViewport(viewport);
  await page.setContent(html);
  await page.screenshot({ path: join(OUT, fileName) });
}

async function captureBasemap(browser) {
  const token = localEnv('VITE_MAPBOX_TOKEN');
  if (!token) return '';

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`
      <html>
        <body style="margin:0">
          <div id="map" style="width:1200px;height:630px"></div>
        </body>
      </html>
    `);
  });
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);
    await page.goto(`http://localhost:${address.port}`);
    await page.addStyleTag({ path: MAPBOX_GL_CSS });
    await page.addScriptTag({ path: MAPBOX_GL_JS });
    await page.evaluate(
      ({ accessToken, style }) =>
        new Promise((resolve, reject) => {
          window.mapboxgl.accessToken = accessToken;
          const map = new window.mapboxgl.Map({
            container: 'map',
            style,
            projection: 'mercator',
            bounds: [[-118.78, 33.7], [-117.72, 34.35]],
            fitBoundsOptions: { padding: 0 },
            interactive: false,
            attributionControl: true,
            fadeDuration: 0,
          });
          const timer = window.setTimeout(() => reject(new Error('Basemap timed out')), 20000);

          map.on('style.load', () => {
            const config = {
              showRoadLabels: false,
              showPointOfInterestLabels: false,
              showTransitLabels: false,
              show3dObjects: false,
              font: 'Inter',
            };
            for (const [key, value] of Object.entries(config)) {
              try {
                map.setConfigProperty('basemap', key, value);
              } catch {
                // Custom styles do not necessarily expose every Standard configuration.
              }
            }
          });
          map.once('load', () => {
            window.setTimeout(() => {
              window.clearTimeout(timer);
              resolve(true);
            }, 3500);
          });
        }),
      {
        accessToken: token,
        style: localEnv('VITE_MAPBOX_STYLE') || DEFAULT_MAPBOX_STYLE,
      },
    );
    const base64 = await page.screenshot({ encoding: 'base64', type: 'png' });
    return `data:image/png;base64,${base64}`;
  } catch (error) {
    console.warn(`basemap unavailable; using vector fallback (${error.message})`);
    return '';
  } finally {
    await page.close();
    server.close();
  }
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

    const basemapDataUrl = await captureBasemap(browser);
    const page = await browser.newPage();
    await screenshot(page, 'og-image.png', ogHtml());
    await screenshot(page, 'og-concept-1-map-portrait.png', conceptMapPortrait());
    await screenshot(page, 'og-concept-2-split-panel.png', conceptSplitPanel());
    await screenshot(page, 'og-concept-3-spotlight.png', conceptSpotlight(basemapDataUrl));
    await screenshot(page, 'og-concepts-sheet.png', comparisonSheet(basemapDataUrl), {
      width: 1780,
      height: 2180,
      deviceScaleFactor: 2,
    });
    await page.close();
  } finally {
    await browser.close();
  }

  console.log(
    'wrote apple-touch-icon.png, og-image.png, 3 concept variants, and og-concepts-sheet.png',
  );
}

await main();
