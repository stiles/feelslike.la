"""Write the published assets: place index, cell forecasts, mapping, frames and manifest.

Values are stored unrounded to whole degrees and carry two decimals, which represents the
source exactly: NDFD ships temperatures in 0.05°C steps, so a converted value like 94.55°F
is the real number rather than a truncation. Rounding to whole degrees is the interface's
job, not the pipeline's.

Missing values are null in every asset. A null is never replaced with zero, a neighbor's
value or an interpolated estimate.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
from rasterio.transform import xy

from .contours import build_bands, display_mask, snap_to_output_precision, write_frame
from .times import iso_z, local_label, utc_key

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Cell:
    cell_id: str
    row: int
    col: int
    window_row: int
    window_col: int
    center_longitude: float
    center_latitude: float


def _json(path: Path, payload: dict, indent: int | None = None) -> int:
    separators = (",", ":") if indent is None else None
    path.write_text(
        json.dumps(payload, indent=indent, separators=separators, allow_nan=False) + "\n"
    )
    return path.stat().st_size


def _optional(value: float) -> float | None:
    number = float(value)
    return None if math.isnan(number) else round(number, 2)


def checksum(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def coverage_cells(reference: dict, boundary, crop_row_off: int, crop_col_off: int) -> list[Cell]:
    """Every native cell touching the display coverage, in row-major order.

    `all_touched` is on so a coordinate anywhere inside the county resolves to a cell that
    has a published series, including along the coast and the county line.
    """
    from rasterio.features import geometry_mask

    covered = ~geometry_mask(
        boundary.to_crs(reference["crs"]).geometry,
        out_shape=(reference["height"], reference["width"]),
        transform=reference["transform"],
        all_touched=True,
        invert=False,
    )
    cells = []
    for window_row, window_col in zip(*np.where(covered), strict=True):
        row = int(window_row) + crop_row_off
        col = int(window_col) + crop_col_off
        longitude, latitude = _center(reference, int(window_row), int(window_col))
        cells.append(
            Cell(
                cell_id=f"r{row}c{col}",
                row=row,
                col=col,
                window_row=int(window_row),
                window_col=int(window_col),
                center_longitude=longitude,
                center_latitude=latitude,
            )
        )
    return cells


def _center(reference: dict, window_row: int, window_col: int) -> tuple[float, float]:
    from pyproj import Transformer

    x, y = xy(reference["transform"], window_row, window_col)
    transformer = Transformer.from_crs(reference["crs"], "EPSG:4326", always_xy=True)
    longitude, latitude = transformer.transform(x, y)
    return round(longitude, 6), round(latitude, 6)


def write_places(directory: Path, places: list, geography_version: str) -> int:
    from dataclasses import asdict

    return _json(
        directory / "places.json",
        {
            "schema_version": SCHEMA_VERSION,
            "geography_version": geography_version,
            "source": "Mapping LA via la-geography",
            "place_count": len(places),
            "places": [asdict(place) for place in places],
        },
    )


def write_cell_forecasts(
    directory: Path,
    cells: list[Cell],
    apparent: np.ndarray,
    air: np.ndarray,
    times: list[datetime],
    grid_fingerprint: str,
) -> tuple[int, dict]:
    records = []
    missing_cells = 0
    for cell in cells:
        apparent_series = [
            _optional(value) for value in apparent[:, cell.window_row, cell.window_col]
        ]
        air_series = [_optional(value) for value in air[:, cell.window_row, cell.window_col]]
        record = {
            "cell_id": cell.cell_id,
            "longitude": cell.center_longitude,
            "latitude": cell.center_latitude,
            "temperature_f": air_series,
            "apparent_temperature_f": apparent_series,
        }
        absent = sum(1 for value in apparent_series + air_series if value is None)
        if absent:
            missing_cells += 1
            record["quality_flags"] = {"missing_values": absent}
        records.append(record)

    size = _json(
        directory / "cell_forecasts.json",
        {
            "schema_version": SCHEMA_VERSION,
            "grid_fingerprint": grid_fingerprint,
            "temperature_unit": "degF",
            "forecast_times": [iso_z(moment) for moment in times],
            "cell_count": len(records),
            "cells": records,
        },
    )
    return size, {"cells": len(records), "cells_with_missing_values": missing_cells}


def mapping_version(grid_fingerprint: str, geography_version: str, entries: dict) -> str:
    """Changes whenever the grid, the geography or any reference point changes.

    A stored mapping is only meaningful for one combination of those three, so this is what
    a consumer compares to decide whether to rebuild.
    """
    payload = json.dumps(
        {
            "grid_fingerprint": grid_fingerprint,
            "geography_version": geography_version,
            "places": {
                slug: [entry.get("cell_id"), entry.get("reference_point")]
                for slug, entry in sorted(entries.items())
            },
        },
        sort_keys=True,
    )
    return "sha256:" + hashlib.sha256(payload.encode()).hexdigest()[:32]


def write_place_cells(
    directory: Path,
    places: list,
    resolver,
    known_cells: set[str],
    grid_fingerprint: str,
    geography_version: str,
) -> tuple[int, dict]:
    entries: dict[str, dict] = {}
    unsupported = 0
    for place in places:
        point = place.reference_point
        entry = {
            "reference_point": [point.longitude, point.latitude],
            "reference_method": point.method,
            "reviewed": point.reviewed,
        }
        try:
            cell = resolver.resolve(point.longitude, point.latitude)
        except ValueError as error:
            entry["cell_id"] = None
            entry["unsupported_reason"] = str(error)
            unsupported += 1
            entries[place.slug] = entry
            continue

        if cell.cell_id not in known_cells:
            entry["cell_id"] = None
            entry["unsupported_reason"] = "reference cell lies outside published coverage"
            unsupported += 1
        else:
            entry["cell_id"] = cell.cell_id
        entries[place.slug] = entry

    size = _json(
        directory / "place_cells.json",
        {
            "schema_version": SCHEMA_VERSION,
            "grid_fingerprint": grid_fingerprint,
            "geography_version": geography_version,
            "mapping_version": mapping_version(grid_fingerprint, geography_version, entries),
            "places": entries,
        },
    )
    return size, {"mapped": len(entries) - unsupported, "unsupported": unsupported}


def projection_parameters(crs) -> dict:
    """The Lambert conformal conic parameters a client needs to project a coordinate.

    Read from the CRS rather than written down, so a change in the source grid shows up
    here instead of silently disagreeing with the data.
    """
    params = {param.name: param.value for param in crs.coordinate_operation.params}
    return {
        "method": crs.coordinate_operation.method_name,
        "latitude_of_origin": params["Latitude of false origin"],
        "central_meridian": params["Longitude of false origin"],
        "standard_parallel_1": params["Latitude of 1st standard parallel"],
        "standard_parallel_2": params["Latitude of 2nd standard parallel"],
        "false_easting": params["Easting at false origin"],
        "false_northing": params["Northing at false origin"],
        "semi_major_metre": crs.ellipsoid.semi_major_metre,
        "semi_minor_metre": crs.ellipsoid.semi_minor_metre,
    }


def proj4_string(parameters: dict) -> str:
    """A proj4 string built from the read parameters, for clients using proj4js.

    NDFD's CONUS grid is defined on a sphere, so this normally emits `+R`. If the source
    ever moves to an ellipsoid, the two axes are emitted separately instead of quietly
    rounding one away.
    """
    major, minor = parameters["semi_major_metre"], parameters["semi_minor_metre"]
    shape = f"+R={major:.12g}" if major == minor else f"+a={major:.12g} +b={minor:.12g}"
    return (
        f"+proj=lcc +lat_1={parameters['standard_parallel_1']:.12g} "
        f"+lat_2={parameters['standard_parallel_2']:.12g} "
        f"+lat_0={parameters['latitude_of_origin']:.12g} "
        f"+lon_0={parameters['central_meridian']:.12g} "
        f"+x_0={parameters['false_easting']:.12g} +y_0={parameters['false_northing']:.12g} "
        f"{shape} +units=m +no_defs"
    )


def write_grid(directory: Path, reference: dict, inventory, crop) -> int:
    """Publish the grid definition so a client can resolve a coordinate to a cell.

    With these parameters and the window transform, a browser can compute the same row and
    column the pipeline used, which avoids shipping a cell-footprint geometry file.
    """
    from pyproj import CRS

    crs = CRS.from_user_input(reference["crs"])
    parameters = projection_parameters(crs)
    return _json(
        directory / "grid.json",
        {
            "schema_version": SCHEMA_VERSION,
            "grid_fingerprint": inventory.grid_fingerprint(),
            "crs_wkt": crs.to_wkt(),
            "proj4": proj4_string(parameters),
            "projection": parameters,
            "source_grid": {"width": inventory.width, "height": inventory.height},
            "window": {
                "col_off": int(crop.col_off),
                "row_off": int(crop.row_off),
                "width": int(crop.width),
                "height": int(crop.height),
            },
            "window_transform": [round(value, 6) for value in tuple(reference["transform"])[:6]],
            "cell_size_m": round(abs(reference["transform"][0]), 3),
            "cell_id_format": "r{row}c{col}, using source grid indexes",
            "cell_lookup": (
                "Project longitude and latitude with the parameters above, then "
                "col = floor((x - window_transform[2]) / window_transform[0]) + window.col_off "
                "and row = floor((y - window_transform[5]) / window_transform[4]) + "
                "window.row_off."
            ),
        },
        indent=2,
    )


def write_frames(
    directory: Path,
    apparent: np.ndarray,
    reference: dict,
    times: list[datetime],
    breaks: list[float],
    boundary,
    simplify_degrees: float,
    precision: int,
    reference_times: list[datetime],
) -> list[dict]:
    frames_directory = directory / "frames"
    frames_directory.mkdir(parents=True, exist_ok=True)
    mask = display_mask(boundary, simplify_degrees)

    entries = []
    for index, moment in enumerate(times):
        bands = build_bands(apparent[index], reference, breaks, clip=mask)
        # Snap before recording band ids and counts, so the manifest describes the file
        # that was written rather than the geometry before precision reduction.
        bands = snap_to_output_precision(bands, precision)
        path = frames_directory / f"{utc_key(moment)}.geojson"
        size = write_frame(bands, path, precision)
        entries.append(
            {
                "valid_time": iso_z(moment),
                "local_label": local_label(moment),
                "path": f"frames/{path.name}",
                "bytes": size,
                "checksum": checksum(path),
                "band_ids": sorted(int(value) for value in bands["band_id"].unique()),
                "feature_count": len(bands),
                "source_reference_times": [iso_z(stamp) for stamp in reference_times],
            }
        )
    return entries


def write_manifest(
    directory: Path,
    *,
    build_id: str,
    download: dict,
    inventory,
    window,
    times: list[datetime],
    breaks: list[float],
    geography_version: str,
    assets: dict,
    frames: list[dict],
    units: list[str],
    generated_at: datetime,
) -> int:
    source_files = []
    for record in download["source_files"]:
        source_files.append(
            {
                "element": record["element"],
                "url": record["url"],
                "bytes": record["bytes"],
                "sha256": record["sha256"],
                "retrieved_at": record["retrieved_at"],
                "last_modified": record.get("last_modified"),
                "declared_unit": units[0] if len(set(units)) == 1 else ",".join(units),
            }
        )

    return _json(
        directory / "manifest.json",
        {
            "schema_version": SCHEMA_VERSION,
            "build_id": build_id,
            "generated_at": iso_z(generated_at),
            "retrieved_at": min(record["retrieved_at"] for record in download["source_files"]),
            "provider": download["provider"],
            "source_sector": download["sector"],
            "source_period": download["period"],
            "source_files": source_files,
            "geography_version": geography_version,
            "grid_fingerprint": inventory.grid_fingerprint(),
            "timezone": "America/Los_Angeles",
            "temperature_unit": "degF",
            "band_breaks_f": breaks,
            "forecast_reference_times": [iso_z(stamp) for stamp in inventory.reference_times],
            "forecast_times": [iso_z(moment) for moment in times],
            "requested_hours": window.requested_hours,
            "complete_24h": window.complete,
            "coverage_note": window.note,
            "assets": assets,
            "frames": frames,
        },
        indent=2,
    )
