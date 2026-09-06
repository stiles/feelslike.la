// Resolving a coordinate to a forecast cell, and to a place name for the label.
//
// The projection parameters and the arithmetic both come from the published grid.json,
// so this reproduces the assignment the pipeline made rather than approximating it. The
// pipeline has a test asserting the two agree for every place in the index.

import proj4 from 'proj4';

import type { Bundle, Grid, Place, Selection } from './types';

export class CellLookup {
  private readonly toGrid: proj4.Converter;

  constructor(private readonly grid: Grid) {
    this.toGrid = proj4('EPSG:4326', grid.proj4);
  }

  /** The cell id containing this coordinate, whether or not a forecast was published. */
  cellId(longitude: number, latitude: number): string {
    const [x, y] = this.toGrid.forward([longitude, latitude]);
    const t = this.grid.window_transform;
    const col = Math.floor((x - t[2]) / t[0]) + this.grid.window.col_off;
    const row = Math.floor((y - t[5]) / t[4]) + this.grid.window.row_off;
    return `r${row}c${col}`;
  }
}

export type Resolution =
  | { kind: 'place'; selection: Selection }
  | { kind: 'coordinate'; selection: Selection }
  | { kind: 'unsupported'; reason: string };

/** A named place resolves through the published mapping, never through its own geometry. */
export function resolvePlace(bundle: Bundle, slug: string): Resolution {
  const place = bundle.places.get(slug);
  if (!place) return { kind: 'unsupported', reason: `We don't have a place called ${slug}.` };

  const entry = bundle.placeCells.places[slug];
  if (!entry?.cell_id || !bundle.cells.has(entry.cell_id)) {
    return {
      kind: 'unsupported',
      reason: `${place.name} sits outside the area this forecast covers.`,
    };
  }
  return {
    kind: 'place',
    selection: { cellId: entry.cell_id, label: place.name, slug, exact: false },
  };
}

/**
 * An exact coordinate takes its own cell and borrows a place's name.
 *
 * Two parts of a large neighborhood can land in different cells, and that is the point:
 * the name is a label, not a replacement coordinate.
 */
export function resolveCoordinate(
  bundle: Bundle,
  lookup: CellLookup,
  longitude: number,
  latitude: number,
  outlines: GeoJSON.FeatureCollection | null,
): Resolution {
  const cellId = lookup.cellId(longitude, latitude);
  if (!bundle.cells.has(cellId)) {
    return {
      kind: 'unsupported',
      reason: 'That location is outside Los Angeles County, so we have no forecast for it.',
    };
  }

  const containing = outlines ? placeAt(outlines, longitude, latitude) : null;
  if (containing && bundle.places.has(containing)) {
    const place = bundle.places.get(containing) as Place;
    return {
      kind: 'coordinate',
      selection: { cellId, label: place.name, slug: containing, exact: true },
    };
  }

  return {
    kind: 'coordinate',
    selection: {
      cellId,
      label: 'Your location',
      slug: null,
      exact: true,
      note: 'This spot is inside the county but outside our named places.',
    },
  };
}

/**
 * Point in polygon against the display outlines.
 *
 * These are simplified geometry, which is fine for choosing a label and would not be
 * fine for choosing a forecast. Right on a boundary the name can go either way; the
 * temperature cannot, because it came from the coordinate.
 */
export function placeAt(
  outlines: GeoJSON.FeatureCollection,
  longitude: number,
  latitude: number,
): string | null {
  for (const feature of outlines.features) {
    const slug = feature.properties?.slug as string | undefined;
    if (!slug || !feature.geometry) continue;
    if (feature.geometry.type === 'Polygon') {
      if (inPolygon(feature.geometry.coordinates, longitude, latitude)) return slug;
    } else if (feature.geometry.type === 'MultiPolygon') {
      for (const polygon of feature.geometry.coordinates) {
        if (inPolygon(polygon, longitude, latitude)) return slug;
      }
    }
  }
  return null;
}

function inPolygon(rings: GeoJSON.Position[][], x: number, y: number): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !inRing(outer, x, y)) return false;
  return !holes.some((hole) => inRing(hole, x, y));
}

function inRing(ring: GeoJSON.Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i] as GeoJSON.Position;
    const b = ring[j] as GeoJSON.Position;
    const [ax, ay] = [a[0] as number, a[1] as number];
    const [bx, by] = [b[0] as number, b[1] as number];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
