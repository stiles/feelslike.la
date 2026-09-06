# Feels Like LA

A mobile-first weather product that answers one question: what will it feel like where I am
in Los Angeles over the next 24 hours?

Apparent-temperature forecasts come from the National Weather Service's National Digital
Forecast Database. Place names come from [la-geography](https://github.com/stiles/la-geography),
which derives its countywide layer from the Los Angeles Times' Mapping LA project. Filled
temperature contours are generated with [isobands](https://palewi.re/docs/isobands/).

The product plan and technical specification live in [`PLANNING.md`](PLANNING.md).
Methodology is in [`docs/methodology.md`](docs/methodology.md).

## Status

Milestones 1 through 3 are done: the data is proven, the pipeline builds, validates and
publishes a complete set of assets, and the interface reads them. Scheduling and
deployment, milestone 4, are not built.

- [`docs/prototype-findings.md`](docs/prototype-findings.md): what one real NDFD cycle
  showed about local temperature variation, grid resolution and source freshness.
- [`docs/pipeline.md`](docs/pipeline.md): build stages, failure behavior and asset
  contracts.
- [`docs/interface.md`](docs/interface.md): what the interface does, what it deliberately
  does not do, and how it is verified.

## Setup

```sh
make install       # Python, through uv
make web-install   # the interface, through npm
```

## Commands

```sh
make build       # one build from current sources
make replay      # the same build from the committed fixture, no NOAA calls
make fixture     # refresh that fixture from current sources
make prototype   # milestone 1 charts, maps and findings
make test        # pytest
make lint        # ruff

make web         # the interface: types, unit tests, bundle and browser checks
make web-smoke   # just the browser checks; SHOTS=1 also writes screenshots
make web-fixture # regenerate the browser lookup's expected cell ids
```

`cd web && npm run dev` serves the interface against whatever build
`build/latest.json` points at, through the `web/public/data` symlink.

A build downloads two GRIB2 files, crops them to Los Angeles County plus a buffer, samples
native cells, contours each hour, validates everything on disk and only then repoints
`build/latest.json`. A build that fails validation is kept under `build/failed/` and the
previously published build stays exactly where it was.

`make replay` rebuilds from `data/fixtures/build.npz` and reproduces the published assets
byte for byte, apart from `generated_at` in the manifest.

## Published assets

Each build writes an immutable directory under `build/builds/<build_id>/`, with
`build/latest.json` pointing at the current one.

| Asset | Contents | Size | Gzipped |
| --- | --- | --- | --- |
| `manifest.json` | Build identity, source files, times, breaks, palette, asset and frame index | 16 KB | 3.0 KB |
| `places.json` | 270 places with reference points and review status | 76 KB | 9.2 KB |
| `place_cells.json` | Place slug to forecast cell, with a mapping version | 37 KB | 5.8 KB |
| `cell_forecasts.json` | 24-hour apparent and air series for 1,850 native cells | 724 KB | 77 KB |
| `grid.json` | Projection parameters and the cell-lookup formula | 2 KB | 0.9 KB |
| `place_outlines.geojson` | Simplified place polygons, for drawing a selection | 304 KB | 68 KB |
| `county.geojson` | County silhouette, for the coastline and the no-data fill | 22 KB | 5.8 KB |
| `frames/<time>.geojson` | 24 filled-contour frames, one per forecast hour | 76 KB each | 18 KB each |

Total is about 3.0 MB, or 590 KB gzipped. Sizes come from the Sept. 6, 2026 build.

First paint needs the manifest, places, mapping, cell series and one frame, about 112 KB
gzipped. The outlines are the largest single asset and load last, after the forecast is
already on screen.

`grid.json` publishes the Lambert conformal conic parameters and window transform, so a
client resolves a coordinate to a cell arithmetically instead of downloading cell geometry.
Tests on both sides assert that formula returns the same cell the pipeline used: a Python
test against the resolver, and a TypeScript test against 1,170 cases the resolver
generated.

The manifest also carries the display palette, one color per temperature class. The map
fills and the legend are both built from it, so they cannot drift apart, and a class with
no color would fail validation rather than render as missing data.

## Layout

```text
config/          Source paths, coverage envelope, display breaks, place overrides
src/feelslike_la/
  fetch.py       Download GRIB2 files, record checksums and retrieval times
  grid.py        Inventory, crop and unit-convert the grids
  geography.py   la-geography places, validation and reference points
  sample.py      Coordinate to native cell, nearest-cell sampling only
  contours.py    Filled contours with fixed class breaks
  export.py      Write the published assets
  validate.py    Checks a build must pass before publishing
  pipeline.py    One build: prepare, assemble, validate, publish
  prototype.py   Milestone 1 charts, maps and findings
scripts/         Cross-language fixture generation
tests/           Failure modes that could make the product mislead
web/
  src/           The interface: card, chart, map, search, slider, comparison
  test/          Unit tests, including the browser lookup against Python's answers
  scripts/       Browser smoke checks
data/            Ignored, except the replay fixture
build/           Ignored
```

## Attribution

Forecast data from [NOAA/National Weather Service](https://digital.weather.gov/?zoom=10&lat=33.98133&lon=-118.44422&layers=FB00TTTFFTT&region=0&element=7&mxmz=false&barbs=false&subl=TFFFFF&units=english&wunits=nautical&coords=latlon&tunits=localt). Place boundaries from Mapping LA via
[la-geography](https://github.com/stiles/la-geography).
