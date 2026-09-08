// Generates public/sitemap.xml — the homepage plus one URL per place.
//
//   npm run sitemap
//
// Place URLs are worth listing individually: each one is a genuine, distinct
// long-tail query ("Venice feels like," "Highland Park feels like") that the SPA
// answers correctly on a direct load (see placeFromUrl() in state.ts), but nothing
// links to any of them from the homepage, so a crawler has no way to discover them
// without this file.
//
// Unlike the OG card (see generate-brand-assets.mjs), this doesn't need re-running on
// every forecast — only when the place list itself changes, which is rare. Re-run after
// pulling a new la-geography release.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
const SITE = 'https://feelslike.la';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadSlugs() {
  const latest = await readJson(join(DATA, 'latest.json'));
  const buildDir = join(DATA, dirname(latest.manifest));
  const places = await readJson(join(buildDir, 'places.json'));
  return places.places.map((place) => place.slug).sort();
}

function xml(slugs) {
  const urls = [SITE + '/', ...slugs.map((slug) => `${SITE}/${slug}`)];
  const entries = urls
    .map((url) => `  <url><loc>${url}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

async function main() {
  const slugs = await loadSlugs();
  await writeFile(join(ROOT, 'public', 'sitemap.xml'), xml(slugs));
  console.log(`wrote sitemap.xml with ${slugs.length + 1} URLs`);
}

await main();
