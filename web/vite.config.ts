import { cp, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

const ROOT = dirname(fileURLToPath(import.meta.url));

// public/data is a symlink to ../../build, the whole local build archive. Vite's default
// publicDir copy would bundle every published forecast build along with it — forecast
// data is deployed to S3 on its own schedule, not baked into the site build — so
// copyPublicDir is off and this plugin copies everything else in public/ instead
// (favicon, OG card, robots.txt, sitemap.xml). Skipping this cost the site all of those:
// with nothing at dist/favicon.svg etc., Vercel's SPA catch-all rewrote each one to
// index.html, so crawlers and browsers alike got the wrong content type back.
function copyPublicAssets(): Plugin {
  return {
    name: 'copy-public-assets',
    apply: 'build',
    async closeBundle() {
      const publicDir = join(ROOT, 'public');
      const outDir = join(ROOT, 'dist');
      const entries = await readdir(publicDir);
      await Promise.all(
        entries
          .filter((entry) => entry !== 'data')
          .map((entry) => cp(join(publicDir, entry), join(outDir, entry), { recursive: true })),
      );
    },
  };
}

// `base` and the data location are both configurable so the same bundle can sit at a
// domain root or under a path on stilesdata.com. Defaults are the local dev setup:
// public/data is a symlink to ../../build, so the app reads the real published build.
export default defineConfig({
  base: process.env.SITE_BASE ?? '/',
  plugins: [copyPublicAssets()],
  build: {
    target: 'es2022',
    sourcemap: true,
    copyPublicDir: false,
  },
  server: { port: 5173 },
});
