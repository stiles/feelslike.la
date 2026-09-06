"""Cell resolution, window offsets, nodata cells and grid-change invalidation."""

from __future__ import annotations

import numpy as np
import pytest
from affine import Affine
from rasterio.windows import Window

from feelslike_la.grid import Band, Inventory
from feelslike_la.sample import CellResolver, series_at

# A small synthetic grid in the NDFD projection, one 2.5 km cell per pixel.
CRS = (
    "+proj=lcc +lat_1=25 +lat_2=25 +lat_0=25 +lon_0=-95 +x_0=0 +y_0=0 "
    "+a=6371200 +b=6371200 +units=m +no_defs"
)
# Origin chosen so Los Angeles sits inside the grid: the real NDFD mosaic places
# downtown near x = -2,177,800, y = 1,192,700 in this projection.
TRANSFORM = Affine(2539.703, 0.0, -2_200_000.0, 0.0, -2539.703, 1_250_000.0)
WIDTH = HEIGHT = 40


def resolver(window: Window | None = None) -> CellResolver:
    return CellResolver(CRS, TRANSFORM, WIDTH, HEIGHT, window=window)


def test_a_coordinate_resolves_to_its_own_cell_center():
    cell = resolver().resolve(-118.2467, 34.0418)
    assert 0 <= cell.row < HEIGHT and 0 <= cell.col < WIDTH
    # The cell center is within one cell diagonal, about 2.2 km, of the request.
    assert abs(cell.center_longitude - (-118.2467)) < 0.03
    assert abs(cell.center_latitude - 34.0418) < 0.03
    assert cell.cell_id == f"r{cell.row}c{cell.col}"


def test_nearby_coordinates_can_share_a_cell():
    """Adjacent small neighborhoods legitimately land in the same forecast cell."""
    first = resolver().resolve(-118.2467, 34.0418)
    second = resolver().resolve(-118.2455, 34.0425)
    assert first.cell_id == second.cell_id


def test_a_coordinate_outside_the_grid_is_rejected():
    with pytest.raises(ValueError, match="outside the source grid"):
        resolver().resolve(-74.0, 40.7)


def test_window_offsets_index_the_cropped_array():
    window = Window(col_off=4, row_off=6, width=12, height=12)
    cell = resolver(window).resolve(-118.2467, 34.0418)
    assert cell.window_row == cell.row - 6
    assert cell.window_col == cell.col - 4


def test_a_cell_outside_the_crop_is_flagged_and_refuses_to_sample():
    window = Window(col_off=0, row_off=0, width=2, height=2)
    cell = resolver(window).resolve(-118.2467, 34.0418)
    assert not cell.inside_window
    with pytest.raises(ValueError, match="outside the cropped window"):
        series_at(np.zeros((4, 2, 2)), cell)


def test_sampling_returns_the_series_for_one_cell():
    window = Window(col_off=0, row_off=0, width=WIDTH, height=HEIGHT)
    cell = resolver(window).resolve(-118.2467, 34.0418)
    frames = np.arange(3 * HEIGHT * WIDTH, dtype="float64").reshape(3, HEIGHT, WIDTH)
    expected = frames[:, cell.window_row, cell.window_col]
    assert np.array_equal(series_at(frames, cell), expected)


def test_a_nodata_cell_yields_missing_values_not_zeros():
    window = Window(col_off=0, row_off=0, width=WIDTH, height=HEIGHT)
    cell = resolver(window).resolve(-118.2467, 34.0418)
    frames = np.full((3, HEIGHT, WIDTH), np.nan)
    assert np.isnan(series_at(frames, cell)).all()


def test_the_published_lookup_formula_matches_the_resolver():
    """grid.json tells clients how to find a cell. It must give the pipeline's answer.

    If this drifts, a browser would read a neighboring cell's forecast under the right
    place name, which is invisible in testing and wrong on the page.
    """
    import math

    from pyproj import Transformer
    from rasterio.windows import transform as window_transform_for

    window = Window(col_off=4, row_off=6, width=20, height=20)
    grid = resolver(window)
    a, _, c, _, e, f = tuple(window_transform_for(window, TRANSFORM))[:6]
    forward = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)

    for longitude, latitude in [
        (-118.2467, 34.0418),
        (-118.4792, 34.0213),
        (-118.10, 34.05),
        (-118.35, 33.95),
    ]:
        x, y = forward.transform(longitude, latitude)
        col = math.floor((x - c) / a) + int(window.col_off)
        row = math.floor((y - f) / e) + int(window.row_off)
        assert f"r{row}c{col}" == grid.resolve(longitude, latitude).cell_id


def inventory(transform: Affine, width: int = WIDTH, height: int = HEIGHT) -> Inventory:
    from datetime import UTC, datetime

    moment = datetime(2026, 9, 6, 20, tzinfo=UTC)
    return Inventory(
        path=None,
        crs_wkt=CRS,
        width=width,
        height=height,
        transform=tuple(transform)[:6],
        bands=[Band(1, "ApparentT", "[C]", moment, moment, 9999.0)],
    )


def test_grid_fingerprint_is_stable_for_the_same_geometry():
    assert inventory(TRANSFORM).grid_fingerprint() == inventory(TRANSFORM).grid_fingerprint()


def test_grid_fingerprint_changes_when_the_grid_moves():
    """A shifted or resized grid must invalidate any place-to-cell mapping built on it."""
    shifted = Affine(2539.703, 0.0, -2_097_460.0, 0.0, -2539.703, 1_100_000.0)
    assert inventory(TRANSFORM).grid_fingerprint() != inventory(shifted).grid_fingerprint()
    assert inventory(TRANSFORM).grid_fingerprint() != inventory(TRANSFORM, width=41).grid_fingerprint()
