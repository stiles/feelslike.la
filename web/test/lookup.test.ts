// The browser's coordinate lookup has to agree with the pipeline's, exactly.
//
// Expectations come from the Python resolver that assigned the published cells. A
// disagreement here is the quietest failure this product can have: a real temperature,
// correctly formatted, from the wrong 2.5 km cell.

import { describe, expect, it } from 'vitest';

import expectations from './fixtures/cell_expectations.json';
import { CellLookup, placeAt } from '../src/lookup';
import type { Grid } from '../src/types';

const grid = {
  grid_fingerprint: expectations.grid_fingerprint,
  proj4: expectations.grid.proj4,
  source_grid: expectations.grid.source_grid,
  window: expectations.grid.window,
  window_transform: expectations.grid.window_transform as Grid['window_transform'],
  cell_size_m: expectations.grid.window_transform[0] as number,
} satisfies Grid;

describe('coordinate to cell', () => {
  const lookup = new CellLookup(grid);

  it('matches the pipeline for every generated case', () => {
    const wrong = expectations.cases.filter(
      (testCase) => lookup.cellId(testCase.longitude, testCase.latitude) !== testCase.cell_id,
    );
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(expectations.cases.length).toBeGreaterThan(1000);
  });

  it('matches for the reviewed place reference points', () => {
    const places = expectations.cases.filter(
      (testCase) => testCase.origin !== 'grid' && testCase.published,
    );
    expect(places.length).toBeGreaterThan(200);
    for (const place of places) {
      expect(lookup.cellId(place.longitude, place.latitude), place.origin).toBe(place.cell_id);
    }
  });

  it('gives neighboring cells to coordinates a cell apart', () => {
    // A 2.5 km step has to land in a different cell, or the lookup is collapsing
    // everything onto one id and the test above would still pass.
    const ids = new Set(
      [0, 1, 2, 3].map((step) => lookup.cellId(-118.4 + step * 0.028, 34.0 + step * 0.023)),
    );
    expect(ids.size).toBe(4);
  });
});

describe('point in polygon', () => {
  const square: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { slug: 'ring-with-hole' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 10],
              [10, 10],
              [10, 0],
              [0, 0],
            ],
            [
              [4, 4],
              [4, 6],
              [6, 6],
              [6, 4],
              [4, 4],
            ],
          ],
        },
      },
    ],
  };

  it('finds a point inside', () => {
    expect(placeAt(square, 1, 1)).toBe('ring-with-hole');
  });

  it('does not claim a point in a hole', () => {
    expect(placeAt(square, 5, 5)).toBeNull();
  });

  it('does not claim a point outside', () => {
    expect(placeAt(square, 11, 5)).toBeNull();
  });
});
