import { defineConfig } from 'vite';

// `base` and the data location are both configurable so the same bundle can sit at a
// domain root or under a path on stilesdata.com. Defaults are the local dev setup:
// public/data is a symlink to ../../build, so the app reads the real published build.
export default defineConfig({
  base: process.env.SITE_BASE ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
    // The dev symlink points at the whole local build archive. Copying it would put
    // several published builds inside the bundle, and forecast data is deployed on its
    // own schedule anyway.
    copyPublicDir: false,
  },
  server: { port: 5173 },
});
