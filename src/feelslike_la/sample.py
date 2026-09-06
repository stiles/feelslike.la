"""Resolve coordinates to native NDFD cells and sample values from them.

Sampling is nearest-cell only. Values are never interpolated between cells, and a
cell identifier is meaningful only alongside the grid fingerprint that produced it.
These identifiers are unrelated to the NWS API's office and gridpoint coordinates.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from pyproj import Transformer
from rasterio.transform import rowcol, xy
from rasterio.windows import Window


@dataclass(frozen=True)
class CellReference:
    """A cell in the full source grid, plus its position inside a cropped window."""

    cell_id: str
    row: int
    col: int
    window_row: int
    window_col: int
    center_longitude: float
    center_latitude: float
    inside_window: bool


class CellResolver:
    def __init__(self, crs, transform, width: int, height: int, window: Window | None = None):
        self.crs = crs
        self.transform = transform
        self.width = width
        self.height = height
        self.window = window
        self._to_grid = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self._to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def resolve(self, longitude: float, latitude: float) -> CellReference:
        x, y = self._to_grid.transform(longitude, latitude)
        row, col = rowcol(self.transform, x, y)
        row, col = int(row), int(col)
        if not (0 <= row < self.height and 0 <= col < self.width):
            raise ValueError(
                f"({longitude}, {latitude}) falls outside the source grid at row {row}, col {col}"
            )
        center_x, center_y = xy(self.transform, row, col)
        center_lon, center_lat = self._to_wgs84.transform(center_x, center_y)

        if self.window is None:
            window_row, window_col, inside = row, col, True
        else:
            window_row = row - int(self.window.row_off)
            window_col = col - int(self.window.col_off)
            inside = (
                0 <= window_row < int(self.window.height)
                and 0 <= window_col < int(self.window.width)
            )

        return CellReference(
            cell_id=f"r{row}c{col}",
            row=row,
            col=col,
            window_row=window_row,
            window_col=window_col,
            center_longitude=round(center_lon, 6),
            center_latitude=round(center_lat, 6),
            inside_window=inside,
        )


def series_at(frames: np.ndarray, cell: CellReference) -> np.ndarray:
    """Pull a (time,) series from a (time, y, x) window stack for one cell."""
    if not cell.inside_window:
        raise ValueError(f"cell {cell.cell_id} lies outside the cropped window")
    return frames[:, cell.window_row, cell.window_col]
