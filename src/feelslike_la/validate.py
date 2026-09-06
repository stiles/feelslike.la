"""Checks a build must pass before it replaces the published pointer.

Every check here exists because failing it would produce a misleading weather product:
a place labeled with another place's forecast, a series shorter than its time index, a
gap presented as complete coverage, or a missing value drawn as a temperature.

Checks read the assembled output on disk, not the in-memory objects that wrote it, so a
serialization mistake cannot pass validation.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path


class ValidationFailed(RuntimeError):
    def __init__(self, report: Report):
        super().__init__("; ".join(report.problems))
        self.report = report


@dataclass
class Report:
    problems: list[str] = field(default_factory=list)
    counts: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.problems

    def fail(self, message: str) -> None:
        self.problems.append(message)

    def require(self, condition: bool, message: str) -> bool:
        if not condition:
            self.fail(message)
        return condition

    def to_dict(self) -> dict:
        return {"ok": self.ok, "problems": self.problems, "counts": self.counts}


def _read(path: Path) -> dict:
    """Strict JSON read: NaN and Infinity are rejected rather than silently accepted."""
    return json.loads(path.read_text(), parse_constant=_reject_constant)


def _reject_constant(name: str):
    raise ValueError(f"JSON contains the non-standard constant {name}")


def _read_reported(path: Path, report: Report) -> dict | None:
    """Read an asset, recording unreadable or non-standard JSON as a problem."""
    try:
        return _read(path)
    except ValueError as error:
        report.fail(f"{path.name} is not valid JSON: {error}")
        return None


def _parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)


def validate_build(directory: Path, expected_hours: int | None = None) -> Report:
    report = Report()
    directory = Path(directory)

    manifest_path = directory / "manifest.json"
    if not manifest_path.exists():
        report.fail("manifest.json is missing")
        return report

    manifest = _read_reported(manifest_path, report)
    if manifest is None:
        return report

    times = manifest.get("forecast_times", [])
    fingerprint = manifest.get("grid_fingerprint")
    report.counts["forecast_times"] = len(times)

    _check_units(manifest, report)
    _check_times(times, manifest, expected_hours, report)
    _check_breaks(manifest, report)
    places = _check_places(directory, manifest, report)
    cells = _check_cell_forecasts(directory, manifest, times, fingerprint, report)
    _check_place_cells(directory, manifest, places, cells, fingerprint, report)
    _check_frames(directory, manifest, times, report)
    return report


def _check_units(manifest: dict, report: Report) -> None:
    report.require(
        manifest.get("temperature_unit") == "degF",
        f"unsupported temperature unit {manifest.get('temperature_unit')!r}",
    )
    for source in manifest.get("source_files", []):
        report.require(
            source.get("declared_unit") in {"degC", "kelvin", "degF"},
            f"source {source.get('element')} declares an unconvertible unit "
            f"{source.get('declared_unit')!r}",
        )


def _check_times(
    times: list[str], manifest: dict, expected_hours: int | None, report: Report
) -> None:
    if not report.require(bool(times), "manifest has no forecast_times"):
        return

    parsed = [_parse(stamp) for stamp in times]
    report.require(
        all(stamp.endswith("Z") for stamp in times),
        "forecast_times must be UTC and end with Z",
    )
    report.require(parsed == sorted(parsed), "forecast_times are not in ascending order")
    report.require(len(set(parsed)) == len(parsed), "forecast_times contain duplicates")

    gaps = [
        (times[index], times[index + 1])
        for index in range(len(parsed) - 1)
        if parsed[index + 1] - parsed[index] != timedelta(hours=1)
    ]
    report.require(not gaps, f"forecast_times are not consecutive hours: {gaps[:3]}")

    complete = manifest.get("complete_24h")
    if expected_hours is not None:
        actual = len(parsed) == expected_hours and not gaps
        report.require(
            complete == actual,
            f"complete_24h is {complete} but the build has {len(parsed)} hours "
            f"with {len(gaps)} gaps",
        )
        if complete:
            report.require(
                len(parsed) == expected_hours,
                f"complete_24h is true with only {len(parsed)} of {expected_hours} hours",
            )

    reference = manifest.get("forecast_reference_times", [])
    report.require(bool(reference), "manifest records no forecast reference time")
    for stamp in ("generated_at", "retrieved_at"):
        report.require(bool(manifest.get(stamp)), f"manifest is missing {stamp}")


def _check_breaks(manifest: dict, report: Report) -> None:
    breaks = manifest.get("band_breaks_f", [])
    if not report.require(bool(breaks), "manifest has no band_breaks_f"):
        return
    report.require(
        breaks == sorted(breaks) and len(set(breaks)) == len(breaks),
        "band_breaks_f must be strictly ascending",
    )


def _check_places(directory: Path, manifest: dict, report: Report) -> dict:
    path = directory / Path(manifest.get("assets", {}).get("places", "places.json")).name
    if not path.exists():
        report.fail(f"{path.name} is missing")
        return {}

    document = _read_reported(path, report)
    if document is None:
        return {}
    places = document.get("places", [])
    report.counts["places"] = len(places)
    report.require(bool(places), "place index is empty")
    report.require(
        document.get("geography_version") == manifest.get("geography_version"),
        "place index geography_version does not match the manifest",
    )

    seen: dict[str, dict] = {}
    duplicates = []
    for place in places:
        slug = place.get("slug")
        if not slug:
            report.fail("a place has no slug")
            continue
        if slug in seen:
            duplicates.append(slug)
        seen[slug] = place

        point = place.get("reference_point") or {}
        longitude, latitude = point.get("longitude"), point.get("latitude")
        finite = (
            isinstance(longitude, (int, float))
            and isinstance(latitude, (int, float))
            and math.isfinite(longitude)
            and math.isfinite(latitude)
        )
        if not finite:
            report.fail(f"{slug} has a non-finite reference point")
            continue
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
            report.fail(f"{slug} has a reference point outside valid coordinates")

    report.require(not duplicates, f"duplicate slugs in the place index: {sorted(set(duplicates))}")
    return seen


def _check_cell_forecasts(
    directory: Path,
    manifest: dict,
    times: list[str],
    fingerprint: str | None,
    report: Report,
) -> dict:
    name = Path(manifest.get("assets", {}).get("cell_forecasts", "cell_forecasts.json")).name
    path = directory / name
    if not path.exists():
        report.fail(f"{name} is missing")
        return {}

    document = _read_reported(path, report)
    if document is None:
        return {}
    report.require(
        document.get("grid_fingerprint") == fingerprint,
        "cell forecasts carry a different grid fingerprint than the manifest",
    )
    report.require(
        document.get("forecast_times") == times,
        "cell forecast times do not match the manifest",
    )

    cells = {}
    for cell in document.get("cells", []):
        cell_id = cell.get("cell_id")
        if not cell_id:
            report.fail("a cell record has no cell_id")
            continue
        if cell_id in cells:
            report.fail(f"duplicate cell_id {cell_id}")
        cells[cell_id] = cell

        for key in ("temperature_f", "apparent_temperature_f"):
            series = cell.get(key)
            if not isinstance(series, list):
                report.fail(f"{cell_id} is missing {key}")
                continue
            if len(series) != len(times):
                report.fail(
                    f"{cell_id} {key} has {len(series)} values for {len(times)} forecast times"
                )
            for value in series:
                if value is not None and not (
                    isinstance(value, (int, float)) and math.isfinite(value)
                ):
                    report.fail(f"{cell_id} {key} contains a non-finite value")
                    break

    report.counts["cells"] = len(cells)
    report.require(bool(cells), "cell forecasts are empty")
    return cells


def _check_place_cells(
    directory: Path,
    manifest: dict,
    places: dict,
    cells: dict,
    fingerprint: str | None,
    report: Report,
) -> None:
    name = Path(manifest.get("assets", {}).get("place_cells", "place_cells.json")).name
    path = directory / name
    if not path.exists():
        report.fail(f"{name} is missing")
        return

    document = _read_reported(path, report)
    if document is None:
        return
    report.require(
        document.get("grid_fingerprint") == fingerprint,
        "place-cell mapping carries a different grid fingerprint than the manifest",
    )
    report.require(
        document.get("geography_version") == manifest.get("geography_version"),
        "place-cell mapping carries a different geography version than the manifest",
    )
    report.require(
        bool(document.get("mapping_version")),
        "place-cell mapping has no mapping_version",
    )

    mapping = document.get("places", {})
    report.counts["mapped_places"] = sum(1 for entry in mapping.values() if entry.get("cell_id"))
    report.counts["unsupported_places"] = len(mapping) - report.counts["mapped_places"]

    if places:
        missing = sorted(set(places) - set(mapping))
        report.require(not missing, f"places absent from the mapping: {missing[:5]}")

    unknown = sorted(
        entry["cell_id"]
        for entry in mapping.values()
        if entry.get("cell_id") and entry["cell_id"] not in cells
    )
    report.require(
        not unknown,
        f"mapping points at cells with no forecast series: {unknown[:5]}",
    )
    for slug, entry in mapping.items():
        if not entry.get("cell_id") and not entry.get("unsupported_reason"):
            report.fail(f"{slug} has no cell and no stated reason")


def _check_frames(directory: Path, manifest: dict, times: list[str], report: Report) -> None:
    frames = manifest.get("frames", [])
    report.counts["frames"] = len(frames)
    report.require(
        len(frames) == len(times),
        f"{len(frames)} frames for {len(times)} forecast times",
    )
    report.require(
        [frame.get("valid_time") for frame in frames] == times,
        "frame valid times do not match forecast_times in order",
    )

    breaks = manifest.get("band_breaks_f", [])
    for frame in frames:
        path = directory / frame["path"] if frame.get("path") else None
        if path is None or not path.exists():
            report.fail(f"frame for {frame.get('valid_time')} is missing its file")
            continue
        if frame.get("bytes") is not None and path.stat().st_size != frame["bytes"]:
            report.fail(f"frame {path.name} size does not match the manifest")

        collection = _read_reported(path, report)
        if collection is None:
            continue

        features = collection.get("features", [])
        if not features:
            report.fail(f"frame {path.name} has no features")
            continue

        for feature in features:
            properties = feature.get("properties", {})
            band_id = properties.get("band_id")
            if not isinstance(band_id, int) or not 0 <= band_id <= len(breaks):
                report.fail(f"frame {path.name} has an out-of-range band_id {band_id}")
                break

            lower, upper = properties.get("lower_f"), properties.get("upper_f")
            expected_lower = None if band_id == 0 else breaks[band_id - 1]
            expected_upper = None if band_id >= len(breaks) else breaks[band_id]
            if lower != expected_lower or upper != expected_upper:
                report.fail(
                    f"frame {path.name} band {band_id} declares bounds "
                    f"{lower}-{upper} instead of {expected_lower}-{expected_upper}"
                )
                break

            geometry = feature.get("geometry") or {}
            if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
                report.fail(f"frame {path.name} has a {geometry.get('type')} geometry")
                break
            if not geometry.get("coordinates"):
                report.fail(f"frame {path.name} has an empty geometry")
                break


def validate_geometry(frames_directory: Path) -> Report:
    """Shapely-level geometry validity, kept separate because it needs geopandas."""
    import geopandas as gpd

    report = Report()
    paths = sorted(Path(frames_directory).glob("*.geojson"))
    report.counts["frames"] = len(paths)
    for path in paths:
        frame = gpd.read_file(path)
        invalid = int((~frame.geometry.is_valid).sum())
        if invalid:
            report.fail(f"{path.name} has {invalid} invalid geometries")
        if frame.geometry.is_empty.any():
            report.fail(f"{path.name} has empty geometries")
    return report
