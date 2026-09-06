# The build pipeline

One command produces one build:

```sh
make build
```

That runs `python -m feelslike_la.pipeline`, which downloads the current NDFD files, crops
them to Los Angeles County plus a buffer, writes every published asset, validates the
result on disk and only then repoints `build/latest.json`.

## Stages

1. **Fetch.** Downloads `ds.apt.bin` and `ds.temp.bin` with timeouts, four attempts and
   exponential backoff, recording each file's URL, byte count, SHA-256, retrieval time and
   `Last-Modified` in `download.json`.
2. **Prepare.** Inventories both files and refuses to continue unless they share a grid
   fingerprint and an identical list of valid times. Selects up to 24 consecutive hourly
   valid times starting at the first one at or after the current hour, stopping at the
   first gap rather than stitching across the three-hourly tail. Crops to the coverage
   envelope plus four cells and converts to Fahrenheit using each band's declared unit.
3. **Assemble.** Validates the geography, builds the place index, finds every native cell
   touching the county, writes the cell series, maps places to cells, writes the grid
   definition, contours all 24 hours and writes the manifest.
4. **Validate.** Reads the assembled build back off disk and runs every check in
   `validate.py`, plus geometry validity on all 24 frames.
5. **Publish.** Moves the staging directory to `build/builds/<build_id>/` and rewrites
   `build/latest.json` through a temporary file. Prunes builds older than the retention
   window, never the published one.

## Failure behavior

A build that fails validation moves to `build/failed/<build_id>/` for inspection, and
`build/latest.json` keeps pointing at the last build that passed. Nothing partial is ever
published.

A build whose id is older than the currently published one writes its directory but does
not take over the pointer. This is what stops a fixture replay from rolling the live
forecast backwards. Pass `--force` when that is actually what you want.

## Reproducing a build

`make fixture` saves the cropped field and its metadata to `data/fixtures/build.npz`, which
is committed. `make replay` rebuilds from it with no calls to NOAA and reproduces every
asset byte for byte, apart from `generated_at` in the manifest.

Values are stored as float64 in the fixture so a replay reproduces the published numbers
exactly rather than approximately. The fixture is 0.3 MB.

A replay refuses to run if the upstream geography has changed since the fixture was saved,
because the output would no longer match. `--allow-geography-drift` overrides that and logs
the version change.

## Assets

See the table in the [README](../README.md). Two of them deserve a note.

**`cell_forecasts.json`** carries one record per native cell touching the county, 1,850 of
them, each with 24 apparent and 24 air temperatures. Values keep two decimals, which
represents the source exactly: NDFD ships 0.05°C steps, so 94.55°F is the real converted
number. Whole-degree rounding is the interface's job. Missing values are null, and a null
is never filled from a neighbor.

**`grid.json`** publishes the Lambert conformal conic parameters, the window transform and
the arithmetic for turning a coordinate into a cell id. That replaces a cell-footprint
geometry file entirely. A test asserts the published formula returns the cell the pipeline
itself used, for a set of coordinates across the county.

## Cell ids

A cell id like `r801c238` is the row and column in the full 2145 x 1377 source grid. It is
meaningful only alongside the `grid_fingerprint` that produced it, and it has nothing to do
with the NWS API's office and gridpoint coordinates. `place_cells.json` carries a
`mapping_version` derived from the grid fingerprint, the geography version and every
reference point, so a consumer can tell when a stored mapping is stale.

## What runs in CI

Not wired up yet. The intended shape follows the bots pattern: `make all` on an hourly
schedule, then sync `build/` to S3, uploading the `latest.json` pointer last so readers
never see a manifest whose frames have not arrived.
