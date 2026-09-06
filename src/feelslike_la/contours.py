"""Turn a cropped temperature field into filled display contours.

Contouring happens in the grid's native projection on the buffered field, then the
result is reprojected to WGS84 and clipped to the display coverage. Class breaks are
fixed and shared by every frame so colors mean the same thing across hours.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import xarray as xr
from rasterio.transform import xy
from shapely.geometry import mapping

NODATA_SENTINEL = -9999.0

FRAME_COLUMNS = ["band_id", "lower_f", "upper_f", "observed_min_f", "observed_max_f", "geometry"]


def field_to_dataarray(values: np.ndarray, transform) -> xr.DataArray:
    """Wrap a (y, x) array with native projected cell-center coordinates."""
    if values.ndim != 2:
        raise ValueError(f"expected a 2-D field, got shape {values.shape}")
    height, width = values.shape
    xs = [xy(transform, 0, col)[0] for col in range(width)]
    ys = [xy(transform, row, 0)[1] for row in range(height)]
    return xr.DataArray(values, dims=("y", "x"), coords={"x": xs, "y": ys})


def band_id_for(minimum: float, breaks: list[float], tolerance: float = 1e-6) -> int:
    """Stable class index: 0 below the first break, k for [breaks[k-1], breaks[k])."""
    return int(sum(1 for edge in breaks if minimum >= edge - tolerance))


def build_bands(values: np.ndarray, reference: dict, breaks: list[float], clip=None):
    """Return a GeoDataFrame of filled contour polygons in EPSG:4326.

    `values` is a (y, x) Fahrenheit field where NaN marks unavailable cells.
    """
    import geopandas as gpd
    import isobands

    if not np.any(np.isfinite(values)):
        raise ValueError("field has no finite values to contour")

    filled = np.where(np.isfinite(values), values, NODATA_SENTINEL)
    data = field_to_dataarray(filled, reference["transform"])
    bands = isobands.from_raster(
        data,
        levels=list(breaks),
        crs=reference["crs"],
        nodata=NODATA_SENTINEL,
    )

    bands = bands.to_crs("EPSG:4326")
    bands["band_id"] = [band_id_for(v, breaks) for v in bands["min_value"]]
    # Object dtype so an open-ended class stays a real null instead of becoming NaN,
    # which is not valid JSON and reads as a number in most clients.
    bands["lower_f"] = pd.Series(
        [None if band_id == 0 else float(breaks[band_id - 1]) for band_id in bands["band_id"]],
        index=bands.index,
        dtype=object,
    )
    bands["upper_f"] = pd.Series(
        [
            None if band_id >= len(breaks) else float(breaks[band_id])
            for band_id in bands["band_id"]
        ],
        index=bands.index,
        dtype=object,
    )
    bands["observed_min_f"] = bands["min_value"].round(2)
    bands["observed_max_f"] = bands["max_value"].round(2)

    if clip is not None:
        bands = gpd.clip(bands, clip)
        bands = bands[~bands.geometry.is_empty & bands.geometry.notna()]

    return bands[FRAME_COLUMNS].sort_values("band_id").reset_index(drop=True)


def display_mask(boundary, tolerance: float):
    """Simplify the clip boundary for display.

    Clipping contours against the full-resolution county polygon copies its 66,000-vertex
    coastline into every band that touches the water. Simplifying the mask cuts frame size
    by an order of magnitude and changes only the coastline's drawn detail, never a
    temperature value.
    """
    simplified = boundary.copy()
    simplified["geometry"] = boundary.geometry.simplify(tolerance, preserve_topology=True)
    return simplified


def _round_coordinates(value, precision: int):
    if isinstance(value, (list, tuple)):
        return [_round_coordinates(item, precision) for item in value]
    return round(float(value), precision)


def _optional_number(value) -> float | None:
    """An open-ended class boundary stays null; anything else becomes a number."""
    if value is None:
        return None
    number = float(value)
    return None if math.isnan(number) else number


def write_frame(bands, path, precision: int = 4) -> int:
    """Write one frame as GeoJSON. Returns bytes written.

    Serialized here rather than through GDAL so open-ended class boundaries stay JSON
    nulls instead of the strings or NaN literals a driver round-trip produces.
    """
    features = []
    for row in bands.itertuples():
        geometry = mapping(row.geometry)
        geometry["coordinates"] = _round_coordinates(geometry["coordinates"], precision)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "band_id": int(row.band_id),
                    "lower_f": _optional_number(row.lower_f),
                    "upper_f": _optional_number(row.upper_f),
                    "observed_min_f": round(float(row.observed_min_f), 2),
                    "observed_max_f": round(float(row.observed_max_f), 2),
                },
                "geometry": geometry,
            }
        )
    payload = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
    path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    return path.stat().st_size


def vertex_count(bands) -> int:
    total = 0
    for geometry in bands.geometry:
        parts = geometry.geoms if geometry.geom_type == "MultiPolygon" else [geometry]
        for part in parts:
            total += len(part.exterior.coords)
            total += sum(len(ring.coords) for ring in part.interiors)
    return total
