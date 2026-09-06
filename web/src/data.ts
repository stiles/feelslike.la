// Loading the published build.
//
// The pointer file names an immutable build directory, so every asset in one session
// comes from the same build. Reading the pointer and then resolving assets against that
// build's own directory is what stops a refresh mid-session from pairing new frames with
// an old place-cell mapping.

import type {
  Bundle,
  CellForecast,
  CellForecasts,
  Grid,
  Manifest,
  Place,
  PlaceCells,
  PlaceIndex,
} from './types';

const DATA_BASE = (import.meta.env.VITE_DATA_BASE ?? '/data').replace(/\/$/, '');

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** Load the current build's core assets. Frames and outlines come later. */
export async function loadBundle(): Promise<Bundle> {
  const pointer = await getJson<{ build_id: string; manifest: string }>(
    `${DATA_BASE}/latest.json`,
  );
  const base = `${DATA_BASE}/${pointer.manifest.replace(/\/manifest\.json$/, '')}`;
  const manifest = await getJson<Manifest>(`${base}/manifest.json`);

  const [placeIndex, placeCells, cellForecasts, grid] = await Promise.all([
    getJson<PlaceIndex>(`${base}/${manifest.assets.places}`),
    getJson<PlaceCells>(`${base}/${manifest.assets.place_cells}`),
    getJson<CellForecasts>(`${base}/${manifest.assets.cell_forecasts}`),
    getJson<Grid>(`${base}/${manifest.assets.grid}`),
  ]);

  assertOneBuild(manifest, placeIndex, placeCells, cellForecasts, grid);

  const places = new Map<string, Place>(placeIndex.places.map((place) => [place.slug, place]));
  const ordered = [...placeIndex.places].sort((a, b) => a.name.localeCompare(b.name));
  const cells = new Map<string, CellForecast>(
    cellForecasts.cells.map((cell) => [cell.cell_id, cell]),
  );

  return { base, manifest, places, ordered, placeCells, cells, grid };
}

/**
 * Refuse to draw a forecast from assets that disagree about their own provenance.
 *
 * A mismatch here means a cell id could mean a different cell in two files, which shows
 * up as one neighborhood quietly wearing another's temperature.
 */
function assertOneBuild(
  manifest: Manifest,
  placeIndex: PlaceIndex,
  placeCells: PlaceCells,
  cellForecasts: CellForecasts,
  grid: Grid,
): void {
  const fingerprints = [
    manifest.grid_fingerprint,
    placeCells.grid_fingerprint,
    cellForecasts.grid_fingerprint,
    grid.grid_fingerprint,
  ];
  if (new Set(fingerprints).size !== 1) {
    throw new Error(`assets disagree about the grid: ${fingerprints.join(' ')}`);
  }
  const geographies = [
    manifest.geography_version,
    placeIndex.geography_version,
    placeCells.geography_version,
  ];
  if (new Set(geographies).size !== 1) {
    throw new Error('assets disagree about the geography version');
  }
  if (cellForecasts.forecast_times.join() !== manifest.forecast_times.join()) {
    throw new Error('cell forecasts and the manifest disagree about forecast times');
  }
  if (manifest.temperature_unit !== 'degF') {
    throw new Error(`unexpected unit ${manifest.temperature_unit}`);
  }
}

export type FrameCollection = GeoJSON.FeatureCollection;

/**
 * Frames, fetched once and kept.
 *
 * `frame` awaits the hour the reader is looking at; `prefetch` warms neighbors without
 * blocking anything. First render therefore waits on one file, not 24.
 */
export class FrameStore {
  private readonly cache = new Map<number, Promise<FrameCollection>>();

  constructor(
    private readonly base: string,
    private readonly manifest: Manifest,
  ) {}

  frame(index: number): Promise<FrameCollection> {
    const entry = this.manifest.frames[index];
    if (!entry) return Promise.reject(new Error(`no frame at index ${index}`));
    let pending = this.cache.get(index);
    if (!pending) {
      pending = getJson<FrameCollection>(`${this.base}/${entry.path}`).catch((error) => {
        // Drop the rejection so a transient failure can be retried on the next scrub
        // instead of poisoning this hour for the rest of the session.
        this.cache.delete(index);
        throw error;
      });
      this.cache.set(index, pending);
    }
    return pending;
  }

  has(index: number): boolean {
    return this.cache.has(index);
  }

  /** Warm the hours on either side, nearest first. Failures are ignored. */
  prefetch(index: number, radius = 3): void {
    for (let step = 1; step <= radius; step += 1) {
      for (const candidate of [index + step, index - step]) {
        if (candidate >= 0 && candidate < this.manifest.frames.length && !this.has(candidate)) {
          void this.frame(candidate).catch(() => undefined);
        }
      }
    }
  }
}

let outlines: Promise<GeoJSON.FeatureCollection> | null = null;
let county: Promise<GeoJSON.FeatureCollection> | null = null;

/** The county silhouette: small, and the map needs it as soon as it exists. */
export function loadCounty(bundle: Bundle): Promise<GeoJSON.FeatureCollection> {
  if (!county) {
    county = getJson<GeoJSON.FeatureCollection>(
      `${bundle.base}/${bundle.manifest.assets.county}`,
    );
  }
  return county;
}

/**
 * Place outlines, deferred.
 *
 * At 68 KB gzipped this is the largest asset and nothing on screen needs it until a
 * place is drawn on the map, so it never delays the forecast card.
 */
export function loadOutlines(bundle: Bundle): Promise<GeoJSON.FeatureCollection> {
  if (!outlines) {
    outlines = getJson<GeoJSON.FeatureCollection>(
      `${bundle.base}/${bundle.manifest.assets.place_outlines}`,
    );
  }
  return outlines;
}
