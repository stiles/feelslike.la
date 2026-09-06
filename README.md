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

Milestones 1 and 2 are done: the data is proven and the pipeline builds, validates and
publishes a complete set of assets. The interface is not built yet.

- [`docs/prototype-findings.md`](docs/prototype-findings.md): what one real NDFD cycle
  showed about local temperature variation, grid resolution and source freshness.

## Setup

```sh
make install
```

## Commands

```sh
make build       # one build from current sources
make replay      # the same build from the committed fixture, no NOAA calls
make fixture     # refresh that fixture from current sources
make prototype   # milestone 1 charts, maps and findings
make test        # pytest
make lint        # ruff
```

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
| `manifest.json` | Build identity, source files, times, breaks, asset and frame index | 14 KB | 2.5 KB |
| `places.json` | 270 places with reference points and review status | 77 KB | 9.3 KB |
| `place_cells.json` | Place slug to forecast cell, with a mapping version | 37 KB | 5.8 KB |
| `cell_forecasts.json` | 24-hour apparent and air series for 1,850 native cells | 725 KB | 75 KB |
| `grid.json` | Projection parameters and the cell-lookup formula | 1.7 KB | 0.7 KB |
| `frames/<time>.geojson` | 24 filled-contour frames, one per forecast hour | 75 KB each | 17 KB each |

Total is about 2.6 MB, or 505 KB gzipped. Sizes come from the Sept. 6, 2026 build.

`grid.json` publishes the Lambert conformal conic parameters and window transform, so a
client resolves a coordinate to a cell arithmetically instead of downloading cell geometry.
A test asserts that formula returns the same cell the pipeline used.

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
tests/           Failure modes that could make the product mislead
data/            Ignored, except the replay fixture
build/           Ignored
```

## Attribution

Forecast data from NOAA/National Weather Service. Place boundaries from Mapping LA via
la-geography.
