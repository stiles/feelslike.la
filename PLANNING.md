# Feels Like LA: product plan and technical specification

Prepared September 6, 2026. Working name: feelslike.la.

## Start here

Build a small, mobile-first weather product that answers: **What will it feel like where I am in LA over the next 24 hours?** Use National Weather Service gridded forecasts, recognizable LA place names from Matt Stiles’ la-geography project and filled temperature contours generated with Ben Welsh’s isobands library.

Begin with a data feasibility prototype: one real forecast download, six place time series and 24 hourly map frames. Establish that the local detail is useful before building the complete interface.

This document records researched findings and proposed implementation choices. No live forecast raster has yet been decoded, no export has been independently counted and no weather app has been built. Do not describe these steps as completed. Confirm current provider paths, variable metadata and library interfaces during implementation.

## Product intent

LA’s temperature varies enough across the coast, basin, valleys and mountains to make a countywide forecast feel irrelevant to an individual reader. Make those differences easy to understand and personal through familiar place names.

The product should feel simple and fun, with a smart, restrained design. Its personality should come from local comparisons, clear language and the changing weather map. Avoid invented comfort scores, elaborate rankings and a dashboard full of weather variables.

The user proposed howhot.la and feelslike.la and reported both available. Availability has not been independently checked. feelslike.la is the recommended working name because it accommodates cool evenings and mild weather as well as heat. Final naming remains the user’s choice.

## Guiding principles

- Start with official NWS forecasts and make their definition of apparent temperature clear.
- Use the source grid for numerical lookups and isobands for display.
- Use recognizable, sourced place names without implying street-level forecast precision.
- Show whole degrees Fahrenheit; retain unrounded values for calculations.
- Keep the map’s temperature colors and class breaks consistent across time.
- Keep geography reusable and versioned separately from frequently changing forecasts.
- Prefer a scheduled Python pipeline and static web assets over a request-time weather backend.
- Let search and the forecast card work independently of geolocation and map rendering.

## Version-one scope

### Reader experience

1. Search for a neighborhood, city or unincorporated community, or explicitly choose “Use my location.”
2. See the selected place, forecast hour and a large feels-like value, with air temperature secondary.
3. Read a compact 24-hour chart showing the expected peak and evening cooldown.
4. Scrub the map through the same forecast hours.
5. Compare the selected place with one other place at the same hour.
6. Save the selected place locally and share a place URL such as `/del-rey`.

Open the map on the basin, coast and valleys while supporting the verified county coverage in search. Do not silently advertise full county coverage if the source geography or forecast mask excludes islands or remote areas. Surface unsupported locations clearly.

### Initial exclusions

Do not add accounts, alerts, notifications, precipitation tracking, historical rankings, health recommendations, custom comfort indices, travel routing or a general-purpose weather dashboard. Domain registration and public deployment are separate actions from implementing this specification.

## Forecast data

### Primary source: NDFD

The National Digital Forecast Database combines NWS forecasts into a gridded mosaic. CONUS grid spacing is approximately 2.5 km, about 1.6 miles. This supports local differences across LA but does not resolve individual blocks, buildings, shade trees or pavement conditions.

Acquire both apparent temperature and air temperature. Prefer bulk GRIB2 grids for producing the spatial surface. NOAA’s public NDFD AWS collection is a documented distribution route; inspect its current inventory and product documentation to identify the correct operational files, geographic sector and forecast periods. Do not invent a bucket key or assume a regional sector has the same resolution as the CONUS grid.

The NWS specification describes apparent-temperature values hourly through 36 hours after issuance, then at coarser intervals farther out. Use actual file valid times as authoritative. Target a rolling 24-hour horizon; do not silently manufacture hourly observations from a coarser product.

### What apparent temperature means

NWS apparent temperature uses wind chill at low temperatures and heat index at high temperatures. Its specification uses air temperature between 51°F and 80°F. In mild LA weather, apparent and air temperature will therefore often match.

The heat-index component assumes shady, light-wind conditions. The value is not a complete measure of exposure in direct sunshine. Do not apply a blanket sunshine adjustment or suggest that the product describes every person’s thermal experience.

Suggested methodology wording to refine during implementation: “Feels like uses the National Weather Service’s apparent-temperature forecast, based on temperature, humidity and wind. Local shade and sunshine can change how it feels.”

### Secondary access route: NWS API

For a coordinate:

1. Request `https://api.weather.gov/points/{latitude},{longitude}` with a descriptive User-Agent and contact information.
2. Follow the returned `properties.forecastGridData` URL.
3. Read `properties.apparentTemperature` and `properties.temperature` with their declared units.
4. Parse each value’s ISO 8601 `validTime` interval and duration.

Use this for a quick six-place experiment and semantic spot checks. The raw grid data endpoint is distinct from the formatted `/forecast/hourly` endpoint. Repeated values may be represented as multi-hour intervals; expanding those intervals is different from interpolating a coarse forecast.

API and bulk data can differ in update timing. Compare only after checking valid times, freshness, units and cell locations. Do not use a grid of arbitrary API requests as an unexamined substitute for the native raster.

### Alternative evaluated

Open-Meteo offers convenient point forecasts and an apparent-temperature calculation incorporating wind, humidity and solar radiation. It is a useful comparison source, but its values are not definitionally interchangeable with NWS apparent temperature. Do not blend providers or switch automatically without making the change explicit. NDFD is the recommended initial source.

## Geography integration

### Existing project

Repository: https://github.com/stiles/la-geography

The repository tree inspected during planning was at commit `97d65399511d5566fcae345dd7b69ed1db7afdb5`. Inspect current state and applicable repository instructions before implementation; use a pinned commit or recorded data snapshot for reproducibility.

Relevant files:

- `config/layers.yml`: sources, IDs, expected counts and layer definitions.
- `docs/SIMPLIFIED_GEOJSON.md`: web geometry export and retained properties.
- `lambda/lookup/config.py`: lookup layers and coverage checks.
- `lambda/lookup/handler.py`: spatial lookup and place classifications.
- `scripts/simplify_neighborhoods.py`: existing simplification workflow.

Published URLs documented by the repository:

- Full places: https://stilesdata.com/la-geography/la_neighborhoods_comprehensive.geojson
- Simplified places: https://stilesdata.com/la-geography/la_neighborhoods_comprehensive_simplified.geojson
- Regions: https://stilesdata.com/la-geography/la_regions.geojson
- County boundary: https://stilesdata.com/la-geography/la_county_boundary.geojson
- Existing lookup: https://api.stilesdata.com/la-geography/lookup

These URLs were found in source documentation, not validated by downloading their current bytes. The simplified places export is documented at roughly 1.2 MB, compared with roughly 5.7 MB for the full export. Measure actual and compressed sizes during the prototype.

### Source and naming

The countywide layer derives from LA Times Mapping LA. It includes LA city neighborhoods, incorporated cities and unincorporated areas. Credit Mapping LA and la-geography. Do not describe the entire layer as legally official neighborhood boundaries. The repository describes a separate LA city subset as officially adopted; verify that claim with the city before repeating it publicly. Neighborhood council boundaries are a distinct administrative geography.

Use existing `slug` identifiers as keys and preserve display names. Validate actual exported property values: documentation and code use somewhat different examples for `type` and `city`.

| Existing field | Use |
| --- | --- |
| `slug` | Place ID, forecast join key and URL path |
| `name` | Display name and search label |
| `region` | Search grouping and contextual labels |
| `type` | Source classification of city, neighborhood or unincorporated area |
| `city` | Parent city, when present |

### Known issues to resolve

- README says 270 places; layer configuration expects 269 with a tolerance of five. Count the current export, check duplicate slugs and document coverage. Do not hard-code either count without verification.
- The current lookup uses `contains()`, which excludes points exactly on a polygon boundary. Define deterministic boundary behavior, such as `covers()` followed by an explicit tie rule and a way to choose an adjacent place.
- The lookup configuration bounds coordinates to longitude -119.0 to -117.6 and latitude 33.7 to 34.8. This excludes portions of the county. Derive coverage from verified polygons instead of copying that check.
- The API uses simplified geography. Use the full polygons for authoritative assignments and simplified polygons for display; inspect coastal slivers, shared edges and simplification gaps.
- The existing general-purpose API loads many unrelated layers. For the weather app, prefer a lightweight place lookup or browser-side lookup on a measured-size geography asset.

### Place reference points and exact coordinates

A neighborhood search selects a reviewed reference point within that place. Generate candidate interior points, then review coastal, elongated, mountainous and unusually large places. A centroid or generic representative point is not automatically representative of where residents live.

An exact user coordinate selects its own native forecast cell. The neighborhood supplies a label, not a forced replacement coordinate. Different parts of a large neighborhood may receive different forecasts; adjacent small neighborhoods may legitimately share a cell.

Store reference-point method and review status. Version the place-to-grid mapping against the grid geometry fingerprint and geography snapshot. Rebuild it if either changes. Do not derive values from contour polygon classes.

## Processing architecture

### Proposed stack

- Python managed with `uv`; select a supported Python version after verifying dependencies.
- Rasterio/GDAL for raster inspection, cropping, reprojection and sampling; confirm the installed build can decode the chosen GRIB2 product.
- NumPy for arrays and calculations; GeoPandas, Shapely and PyProj for geography.
- Ben Welsh’s `isobands` for filled contours. Read its current documentation and pin a tested version before writing integration code; no function signatures were validated during planning.
- Pandas or PyArrow for internal tabular output when useful.
- TypeScript and Vite for a small static frontend, MapLibre GL JS for mapping and D3 for a compact forecast chart. These are proposed defaults, not existing project dependencies.
- Scheduled CI or another existing scheduler for hourly updates; object storage/CDN for outputs. Hosting details remain configurable.

### Update sequence

1. Resolve the latest suitable operational source files; download with timeouts, retries and bounded backoff. Record URLs, retrieval time and checksums.
2. Inventory the raster: variables, units, projection, grid spacing, transforms, nodata, valid times and available source reference times.
3. Select a consistent set of forecast hours for both variables. Preserve per-frame source metadata if the product combines differing reference times.
4. Crop to a verified coverage envelope plus a buffer of several native cells. Account for islands explicitly. Keep an analysis grid in its native projection.
5. Convert temperatures using declared units. For Celsius use `F = C * 9 / 5 + 32`; for Kelvin convert to Celsius first. Never infer units from value magnitudes alone.
6. Sample the native cells for reviewed place points and prepare cell forecasts for arbitrary-coordinate lookup.
7. Generate display contours for each selected hour, using fixed Fahrenheit class breaks. Start at 5°F intervals and compare against 2°F intervals only if the local variation warrants them.
8. Contour the buffered field before clipping to display coverage. Preserve nodata masks. Avoid excessive smoothing or geometry changes that imply additional precision.
9. Export WGS84 GeoJSON, a place index, per-cell forecast series and a manifest. Validate all outputs as one build.
10. Publish immutable build assets, then update the small latest-manifest pointer only after upload and validation succeed.

### Forecast time rules

- Store timestamps in UTC using ISO 8601 with `Z`; display in `America/Los_Angeles`.
- Separate retrieval time, build time, forecast reference time and valid time.
- Select the first available valid hour at or after the current time. Label it with its actual hour; do not call a future hourly forecast an observed “now.”
- Publish 24 consecutive hourly valid times when the source supplies them. If coverage is incomplete, preserve the last successful build or explicitly publish a shorter horizon; never label missing intervals as complete.
- Calculate the peak from unrounded values. Specify whether it is the next 24 hours, the remainder of today or a complete calendar day. Default to “Next 24 hours.”
- A map showing each cell’s daily maximum is not a snapshot at a shared hour. Keep this out of the initial time-slider view.
- Handle daylight-saving transitions by storing distinct UTC instants and disambiguating repeated local labels where needed.

### Location lookup design

For the first prototype, precompute the six reference places. For the complete MVP, export forecasts once per unique native grid cell in the coverage area and a compact cell footprint or equivalent lookup asset. Resolve exact coordinates against those native cells. Share series between places assigned to the same cell.

A cropped cell-footprint GeoJSON is an acceptable first implementation if its measured size is reasonable; include only IDs and geometry, not repeated hourly forecasts. Use a spatial index when needed. Grid-cell IDs must be paired with a grid fingerprint and must not be confused with NWS API office/grid coordinates.

The browser can resolve place names from the place layer and weather cells from the cell layer independently. Offer neighborhood search if geolocation is denied. Ask for geolocation only on a user action; do not put exact coordinates in shared URLs or analytics. Persist a selected place slug by default.

## Output contracts

These are proposed contracts, not examples of existing data. Nulls in the illustrative records mean values must be populated or explicitly marked unavailable; they are not forecast observations.

### Place index: `places.json`

```json
{
  "schema_version": 1,
  "geography_version": "sha256-of-downloaded-geography",
  "places": [
    {
      "slug": "del-rey",
      "name": "Del Rey",
      "region": "westside",
      "source_type": "segment-of-a-city",
      "city": "los-angeles",
      "reference_point": {
        "longitude": null,
        "latitude": null,
        "method": "pending_review",
        "reviewed": false
      },
      "aliases": []
    }
  ]
}
```

Production reference points must be finite, inside the intended polygon and reviewed where required. Preserve raw source classification; derive a separate normalized category only through an explicit mapping.

### Build manifest: `manifest.json`

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer | Contract version |
| `build_id` | string | Immutable build identifier |
| `generated_at` | UTC string | Output creation time |
| `retrieved_at` | UTC string | Source retrieval time |
| `provider` | string | `NWS NDFD` |
| `source_files` | array | URLs, checksums and known reference times |
| `geography_version` | string | Geography content hash |
| `grid_fingerprint` | string | Hash of CRS, dimensions, transform and relevant grid geometry |
| `timezone` | string | `America/Los_Angeles` |
| `temperature_unit` | string | `degF` |
| `band_breaks_f` | number array | Fixed ascending contour thresholds |
| `forecast_times` | UTC string array | Ordered valid times |
| `complete_24h` | boolean | Whether consecutive 24-hour coverage passed validation |
| `assets` | object | Place index, cell geometry, cell series and place-cell mapping URLs |
| `frames` | array | Valid time, contour URL, source reference metadata and checksum |

### Forecast series: `cell_forecasts.json`

Store `grid_fingerprint`, `forecast_times` and `cells`. Each cell record contains:

- `cell_id`: stable within this grid fingerprint.
- `temperature_f`: array of unrounded numbers or nulls.
- `apparent_temperature_f`: array of unrounded numbers or nulls.
- `quality_flags`: optional explicit missing/coarse-source flags.

Both arrays must match `forecast_times` in length and order. Null remains null in all derived output. Provide `place_cells.json` mapping each place slug to its reviewed reference cell and mapping version. Keep these records separate from geometry to avoid duplication.

### Map frames: `frames/{valid_time_key}.geojson`

Each frame is a FeatureCollection of Polygon or MultiPolygon features with:

- `lower_f` and `upper_f`: interval boundaries.
- `band_id`: consistent class identifier across frames.

Define intervals as lower-inclusive and upper-exclusive. Ensure the outer breaks enclose all finite source values, or use explicit open-ended classes. Do not omit values equal to the final threshold. Each file’s valid time comes from its manifest entry. Geometry coordinates are longitude, latitude in EPSG:4326.

Keep the configured palette stable across builds and seasons. Add outer classes if necessary without recoloring existing temperature intervals. Missing data must not be assigned a temperature color.

## Frontend and visual behavior

- Large place name and whole-degree apparent temperature, with forecast hour immediately visible.
- Secondary air-temperature value; explain matching values briefly in methodology rather than adding interface clutter.
- A compact 24-hour chart with peak annotation and a synchronized time cursor.
- Keyboard-operable time slider and search. Label controls for assistive technology.
- Temperature map with quiet geographic context and sparse local labels. Highlight the selected place boundary without obscuring the weather bands.
- Consistent legend; do not rescale the color domain to each frame’s minimum and maximum.
- One optional comparison place. Compute the temperature difference at exactly the same valid time and label warmer/cooler/equal consistently after rounding.
- Use Roboto as a starting typeface. Avoid decorative weather icons unless they help a specific task.
- Respect reduced motion. Scrubbing is sufficient for MVP; autoplay is optional later.
- Show readable loading, missing-data, unsupported-location and stale-forecast states.
- Keep the card and chart available if the basemap fails. Do not encode the only explanation in color.
- Fetch the selected frame first, then prefetch nearby hours. Do not make first render wait for 24 geometry files.
- Measure compressed asset sizes on mobile; choose vector tiles only if GeoJSON payload or rendering measurements justify them.

## Reliability and publication

Schedule an hourly attempt, with concurrency limited to one publisher. Forecast updates need not arrive on a fixed hourly boundary. An unchanged source does not require rebuilding identical geometry.

Record structured logs for source availability, time coverage, cell counts, missing values, contour counts, output sizes and elapsed processing time. Fail clearly when units or grid geometry cannot be interpreted.

Use retries for transient failures and preserve the last successful build. Never replace good outputs with an empty or partial failed build. A stale display must use source freshness where known, not just the most recent download timestamp. Initial configurable policy: warn when no successful refresh has occurred for three hours; independently flag old source data. If no future valid hours remain, remove the forecast claim and show an unavailable state.

Store raw GRIB files and generated frames outside Git. Retain a configurable short archive for debugging and reproducibility, such as seven days initially. Commit source, configuration, dependency locks, methodology and small representative test fixtures.

Suggested layout:

```text
feelslike-la/
  README.md
  pyproject.toml
  uv.lock
  config/
    coverage.json
    forecast.toml
    place_overrides.json
  src/feelslike_la/
    fetch.py
    grid.py
    geography.py
    sample.py
    contours.py
    export.py
    validate.py
    pipeline.py
  tests/
    fixtures/
  web/
    src/
    public/
  data/                  # Ignored; raw and intermediate data
  build/                 # Ignored; generated publish assets
  docs/
    methodology.md
    prototype-findings.md
```

## Implementation milestones and acceptance criteria

### 1. Prove the data

Fetch one real NDFD apparent-temperature grid and matching air-temperature data. Produce an inventory and 24-hour time series for Del Rey, Santa Monica, downtown Los Angeles, Pasadena, Woodland Hills and Lancaster. Resolve each name to the actual source slug; review and record reference coordinates.

Deliver a readable six-place chart, a raw-grid map, a contoured map and concise findings covering local gradients, grid resolution, source freshness, apparent-versus-air differences and missing cells. Report actual observations from the data; a mild day without strong contrast is still a valid result. One cycle cannot establish forecast accuracy.

Acceptance: source metadata is recorded; units and valid times are verified; map and series agree when sampling the same source cells. Compare raw API spot checks only with their timing and grid differences documented.

### 2. Build the reusable pipeline

Prepare the verified place index, place-cell mapping, 24 map frames and manifest. Implement a single documented command to build locally from current sources and another path to reproduce output from a saved fixture.

Acceptance: duplicate slugs, invalid reference points, mismatched series lengths, missing required hours, invalid geometries and unsupported units are detected. A failed build leaves the latest successful output intact.

### 3. Build the small interface

Implement search, explicit geolocation, place URLs, a forecast card, synchronized chart and map, time slider and one comparison place.

Acceptance: place selection and direct links work on mobile and desktop; geolocation denial is recoverable; map failure does not block the forecast; keyboard controls work; every displayed number uses the selected valid time. No mock values appear as live forecasts.

### 4. Operationalize

Configure scheduling and atomic publishing to the chosen destination. Add freshness display, failure logging, archive retention and a short runbook. Review domain and publication choices with the user when relevant to the implementation environment.

Acceptance: one successful update and one simulated failed update demonstrate that valid assets remain available and the freshness state is honest.

## Meaningful tests

Prioritize failure modes that could create a misleading weather product:

- Unit conversion, including nodata propagation.
- UTC-to-LA display across daylight-saving transitions.
- Interval expansion versus unsupported temporal interpolation.
- Sampling at a known grid cell and handling coastline/nodata cells.
- Place boundary tie behavior and outside-coverage behavior.
- Stable place IDs and mapping invalidation when the grid changes.
- Contour threshold edge values, geometry validity and nodata holes.
- Same-hour comparisons and correct peak horizon labeling.
- Atomic publication and last-successful-build behavior.

Do not assert a fixed temperature gradient between places: weather varies. Do not expect smoothed contour boundaries to equal native nearest-cell sampling exactly; validate each against its documented method and inspect large visual discrepancies.

## Instructions for the implementing model

Read this brief and any applicable repository instructions. Start with milestone 1 and carry it through to concrete, reviewable outputs before spending time on the complete UI. Use existing la-geography assets, retain attribution and document any proposed changes to that repository separately.

Verify current NDFD distribution paths and isobands interfaces from primary documentation. Pin tested dependencies. Do not substitute a different apparent-temperature definition, create fine-resolution detail by resampling or label forecasts as observations. If bulk access is blocked, the NWS API can support the six-place time-series experiment, but explicitly report that spatial feasibility remains untested.

Make routine implementation choices independently and record them. Report what was built, what data was actually inspected, what passed validation and what remains uncertain. Keep the product focused on place, time, temperature and comparison.

## Sources and references

Sources were reviewed during the September 6, 2026 planning conversation. Recheck operational details when implementation begins.

- [la-geography repository](https://github.com/stiles/la-geography)
- [Inspected geography configuration](https://github.com/stiles/la-geography/blob/97d65399511d5566fcae345dd7b69ed1db7afdb5/config/layers.yml)
- [Inspected simplified geometry documentation](https://github.com/stiles/la-geography/blob/97d65399511d5566fcae345dd7b69ed1db7afdb5/docs/SIMPLIFIED_GEOJSON.md)
- [Inspected lookup configuration](https://github.com/stiles/la-geography/blob/97d65399511d5566fcae345dd7b69ed1db7afdb5/lambda/lookup/config.py)
- [Inspected lookup implementation](https://github.com/stiles/la-geography/blob/97d65399511d5566fcae345dd7b69ed1db7afdb5/lambda/lookup/handler.py)
- [NOAA NDFD public data distribution](https://registry.opendata.aws/noaa-ndfd/)
- [NWS forecast specification, including apparent temperature, section 3.5](https://www.weather.gov/media/directives/010_pdfs/pd01002001curr.pdf)
- [NDFD spatial resolution documentation](https://graphical.weather.gov/xml/rest.php)
- [NWS API overview](https://www.weather.gov/documentation/services-web-API)
- [NWS gridpoint variables and time intervals](https://weather-gov.github.io/api/gridpoints)
- [NWS explanation of heat-index assumptions](https://www.weather.gov/safety/heat-tools)
- [Open-Meteo forecast variables](https://open-meteo.com/en/docs)
- [Isobands introduction](https://palewi.re/posts/2026/08/19/introducing-isobands/)
- [Isobands documentation: verify API during implementation](https://palewi.re/docs/isobands/)
- [LA GeoHub Mapping LA layer](https://geohub.lacity.org/datasets/la-times-neighborhood-boundaries)
- [Certified neighborhood councils](https://geohub.lacity.org/datasets/lahub%3A%3Aneighborhood-councils-certified/about)
