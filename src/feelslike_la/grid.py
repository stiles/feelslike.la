"""Inventory, crop and unit-convert NDFD GRIB2 grids.

Nothing here infers units or times from value magnitudes: units come from the GRIB
metadata and times come from the per-message reference and valid times.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import Window, from_bounds

from .config import Coverage, load_forecast_config

KNOWN_UNITS = {"[C]": "degC", "[K]": "kelvin", "[F]": "degF"}


class UnsupportedUnit(ValueError):
    """Raised when a band's declared unit is not one we can convert."""


@dataclass(frozen=True)
class Band:
    index: int
    element: str
    unit: str
    reference_time: datetime
    valid_time: datetime
    nodata: float | None

    @property
    def unit_name(self) -> str:
        try:
            return KNOWN_UNITS[self.unit]
        except KeyError as error:
            raise UnsupportedUnit(f"band {self.index} declares unknown unit {self.unit!r}") from error


@dataclass
class Inventory:
    path: Path
    crs_wkt: str
    width: int
    height: int
    transform: tuple[float, ...]
    bands: list[Band] = field(default_factory=list)

    @property
    def valid_times(self) -> list[datetime]:
        return [b.valid_time for b in self.bands]

    @property
    def reference_times(self) -> list[datetime]:
        return sorted({b.reference_time for b in self.bands})

    def grid_fingerprint(self) -> str:
        """Hash of the grid geometry. Place-to-cell mappings are valid only for one value."""
        payload = json.dumps(
            {
                "crs_wkt": self.crs_wkt,
                "width": self.width,
                "height": self.height,
                "transform": [round(v, 6) for v in self.transform],
            },
            sort_keys=True,
        )
        return "sha256:" + hashlib.sha256(payload.encode()).hexdigest()[:32]

    def band_for(self, valid_time: datetime) -> Band:
        for band in self.bands:
            if band.valid_time == valid_time:
                return band
        raise KeyError(f"no band valid at {valid_time.isoformat()}")


def _unix(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromtimestamp(int(float(value)), tz=UTC)


def inventory(path: Path) -> Inventory:
    with rasterio.open(path) as source:
        result = Inventory(
            path=Path(path),
            crs_wkt=source.crs.to_wkt(),
            width=source.width,
            height=source.height,
            transform=tuple(source.transform)[:6],
        )
        for index in range(1, source.count + 1):
            tags = source.tags(index)
            valid = _unix(tags.get("GRIB_VALID_TIME"))
            reference = _unix(tags.get("GRIB_REF_TIME"))
            if valid is None or reference is None:
                raise ValueError(f"{path} band {index} is missing GRIB time metadata")
            result.bands.append(
                Band(
                    index=index,
                    element=tags.get("GRIB_ELEMENT", ""),
                    unit=tags.get("GRIB_UNIT", ""),
                    reference_time=reference,
                    valid_time=valid,
                    nodata=source.nodatavals[index - 1],
                )
            )
    return result


def coverage_window(path: Path, coverage: Coverage) -> Window:
    """Pixel window covering the coverage envelope plus its configured cell buffer."""
    with rasterio.open(path) as source:
        west, south, east, north = transform_bounds(
            "EPSG:4326", source.crs, *coverage.bounds, densify_pts=51
        )
        window = from_bounds(west, south, east, north, transform=source.transform)
        pad = coverage.buffer_cells
        window = Window(
            col_off=int(np.floor(window.col_off)) - pad,
            row_off=int(np.floor(window.row_off)) - pad,
            width=int(np.ceil(window.width)) + 2 * pad,
            height=int(np.ceil(window.height)) + 2 * pad,
        )
        return window.intersection(Window(0, 0, source.width, source.height))


def to_fahrenheit(values: np.ndarray, unit_name: str) -> np.ndarray:
    """Convert using the declared unit. NaN propagates; magnitudes are never guessed."""
    if unit_name == "degF":
        return values
    if unit_name == "degC":
        return values * 9.0 / 5.0 + 32.0
    if unit_name == "kelvin":
        return (values - 273.15) * 9.0 / 5.0 + 32.0
    raise UnsupportedUnit(f"cannot convert unit {unit_name!r}")


def read_frames_f(
    path: Path,
    bands: list[Band],
    window: Window | None = None,
) -> tuple[np.ndarray, dict]:
    """Read the given bands as Fahrenheit, with nodata as NaN.

    Returns the (time, y, x) array and the spatial reference of the window.
    """
    with rasterio.open(path) as source:
        indexes = [b.index for b in bands]
        data = source.read(indexes, window=window, masked=True).astype("float64")
        stack = np.ma.filled(data, np.nan)
        for position, band in enumerate(bands):
            if band.nodata is not None:
                stack[position] = np.where(
                    np.isclose(stack[position], band.nodata), np.nan, stack[position]
                )
            stack[position] = to_fahrenheit(stack[position], band.unit_name)
        transform = source.window_transform(window) if window is not None else source.transform
        reference = {
            "crs": source.crs,
            "transform": transform,
            "width": int(window.width) if window is not None else source.width,
            "height": int(window.height) if window is not None else source.height,
        }
    return stack, reference


def describe(path: Path) -> dict:
    """Human-readable inventory used by the CLI and the findings write-up."""
    result = inventory(path)
    with rasterio.open(path) as source:
        bounds_4326 = transform_bounds(source.crs, "EPSG:4326", *source.bounds, densify_pts=51)
    units = sorted({b.unit for b in result.bands})
    elements = sorted({b.element for b in result.bands})
    times = result.valid_times
    steps = np.diff([t.timestamp() for t in times]) / 3600 if len(times) > 1 else []
    return {
        "path": str(path),
        "size_mb": round(path.stat().st_size / 1e6, 1),
        "bands": len(result.bands),
        "elements": elements,
        "units": units,
        "width": result.width,
        "height": result.height,
        "pixel_size_m": [abs(result.transform[0]), abs(result.transform[4])],
        "grid_fingerprint": result.grid_fingerprint(),
        "bounds_4326": [round(v, 4) for v in bounds_4326],
        "reference_times": [t.isoformat().replace("+00:00", "Z") for t in result.reference_times],
        "first_valid_time": times[0].isoformat().replace("+00:00", "Z"),
        "last_valid_time": times[-1].isoformat().replace("+00:00", "Z"),
        "hour_steps": sorted({float(s) for s in steps}),
        "nodata": sorted({b.nodata for b in result.bands}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    summary = describe(args.path)
    print(json.dumps(summary, indent=2))
    coverage = load_forecast_config().coverage
    window = coverage_window(args.path, coverage)
    print(f"\ncoverage window: {window} -> {int(window.width)}x{int(window.height)} cells")


if __name__ == "__main__":
    main()
