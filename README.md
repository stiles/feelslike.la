# Feels Like LA

A mobile-first weather product that answers one question: what will it feel like where I am
in Los Angeles over the next 24 hours?

Apparent-temperature forecasts come from the National Weather Service's National Digital
Forecast Database. Place names come from [la-geography](https://github.com/stiles/la-geography),
which derives its countywide layer from the Los Angeles Times' Mapping LA project. Filled
temperature contours are generated with [isobands](https://palewi.re/docs/isobands/).

The product plan and technical specification live in [`PLANNING.md`](PLANNING.md).

## Status

Milestone 1, the data feasibility prototype. See [`docs/prototype-findings.md`](docs/prototype-findings.md).

## Setup

```sh
uv sync
```

## Commands

```sh
# Download the latest NDFD apparent- and air-temperature grids for CONUS
uv run python -m feelslike_la.fetch

# Print an inventory of a downloaded GRIB2 file
uv run python -m feelslike_la.grid data/raw/<build>/ds.apt.bin

# Build the six-place prototype series, charts and maps
uv run python -m feelslike_la.prototype
```

## Attribution

Forecast data from NOAA/National Weather Service. Place boundaries from Mapping LA via
la-geography.
