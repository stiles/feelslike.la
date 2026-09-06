"""Build and publish one forecast build.

    uv run python -m feelslike_la.pipeline                    # from current sources
    uv run python -m feelslike_la.pipeline --save-fixture     # and save a replay fixture
    uv run python -m feelslike_la.pipeline --from-fixture PATH # rebuild from that fixture

A build assembles into a staging directory, gets validated on disk, and only then becomes
the published build. A failed build never touches the pointer to the last good one.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
from affine import Affine
from rasterio.windows import Window

from . import export
from . import geography as geo
from .config import BUILD_DIR, DATA_DIR, RAW_DIR, ForecastConfig, load_forecast_config
from .fetch import fetch_all
from .grid import Band, Inventory, coverage_window, inventory, read_frames_f
from .sample import CellResolver
from .times import iso_z, select_hourly_window
from .validate import ValidationFailed, validate_build, validate_geometry

log = logging.getLogger(__name__)

BUILDS_DIR = BUILD_DIR / "builds"
FAILED_DIR = BUILD_DIR / "failed"
LATEST_POINTER = BUILD_DIR / "latest.json"
FIXTURE_DIR = DATA_DIR / "fixtures"


@dataclass
class Prepared:
    """Everything a build needs, from either live files or a fixture."""

    build_id: str
    download: dict
    inventory: Inventory
    window: object
    crop: Window
    reference: dict
    apparent: np.ndarray
    air: np.ndarray
    units: list[str]
    geography_version: str


def prepare_from_source(config: ForecastConfig, raw: Path, hours: int) -> Prepared:
    download = json.loads((raw / "download.json").read_text())
    paths = {record["element"]: Path(record["path"]) for record in download["source_files"]}

    apparent_inventory = inventory(paths["apparent_temperature"])
    air_inventory = inventory(paths["temperature"])
    if apparent_inventory.grid_fingerprint() != air_inventory.grid_fingerprint():
        raise ValueError("apparent and air temperature do not share a grid geometry")
    if apparent_inventory.valid_times != air_inventory.valid_times:
        raise ValueError("apparent and air temperature do not share valid times")

    window = select_hourly_window(apparent_inventory.valid_times, hours=hours)
    if not window.times:
        raise ValueError("no usable forecast hours in this source")
    log.info("time window: %s", window.note)

    bands_apparent = [apparent_inventory.band_for(moment) for moment in window.times]
    bands_air = [air_inventory.band_for(moment) for moment in window.times]
    units = sorted({band.unit_name for band in bands_apparent + bands_air})

    crop = coverage_window(paths["apparent_temperature"], config.coverage)
    apparent, reference = read_frames_f(paths["apparent_temperature"], bands_apparent, crop)
    air, _ = read_frames_f(paths["temperature"], bands_air, crop)
    log.info("cropped field: %s cells per frame", apparent.shape[1:])

    geo.download_geography()
    return Prepared(
        build_id=download["build_id"],
        download=download,
        inventory=apparent_inventory,
        window=window,
        crop=crop,
        reference=reference,
        apparent=apparent,
        air=air,
        units=units,
        geography_version=geo.geography_version(geo.GEOGRAPHY_DIR / geo.FULL_NAME),
    )


def save_fixture(prepared: Prepared, path: Path) -> Path:
    """Store the cropped field and its metadata so a build can be replayed offline.

    Values stay float64 so a replay reproduces the published numbers exactly rather than
    approximately.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "build_id": prepared.build_id,
        "download": prepared.download,
        "units": prepared.units,
        "geography_version": prepared.geography_version,
        "valid_times": [iso_z(moment) for moment in prepared.window.times],
        "window_note": prepared.window.note,
        "window_complete": prepared.window.complete,
        "requested_hours": prepared.window.requested_hours,
        "reference_times": [iso_z(stamp) for stamp in prepared.inventory.reference_times],
        "source_grid": {
            "crs_wkt": prepared.inventory.crs_wkt,
            "width": prepared.inventory.width,
            "height": prepared.inventory.height,
            "transform": list(prepared.inventory.transform),
        },
        "crop": {
            "col_off": int(prepared.crop.col_off),
            "row_off": int(prepared.crop.row_off),
            "width": int(prepared.crop.width),
            "height": int(prepared.crop.height),
        },
        "window_transform": list(tuple(prepared.reference["transform"])[:6]),
    }
    np.savez_compressed(
        path,
        apparent=prepared.apparent,
        air=prepared.air,
        metadata=np.array(json.dumps(metadata)),
    )
    log.info("wrote fixture %s (%.1f MB)", path, path.stat().st_size / 1e6)
    return path


def prepare_from_fixture(path: Path, allow_geography_drift: bool = False) -> Prepared:
    with np.load(path, allow_pickle=False) as archive:
        apparent = archive["apparent"]
        air = archive["air"]
        metadata = json.loads(str(archive["metadata"]))

    times = [datetime.fromisoformat(stamp) for stamp in metadata["valid_times"]]
    reference_times = [datetime.fromisoformat(stamp) for stamp in metadata["reference_times"]]
    grid = metadata["source_grid"]
    crop = Window(**metadata["crop"])

    restored = Inventory(
        path=path,
        crs_wkt=grid["crs_wkt"],
        width=grid["width"],
        height=grid["height"],
        transform=tuple(grid["transform"]),
        bands=[
            Band(
                index=index + 1,
                element="ApparentT",
                unit="[C]",
                reference_time=reference_times[0],
                valid_time=moment,
                nodata=9999.0,
            )
            for index, moment in enumerate(times)
        ],
    )

    from .times import HourlyWindow

    window = HourlyWindow(
        times=times,
        complete=metadata["window_complete"],
        requested_hours=metadata["requested_hours"],
        note=metadata["window_note"],
    )

    geo.download_geography()
    current_version = geo.geography_version(geo.GEOGRAPHY_DIR / geo.FULL_NAME)
    if current_version != metadata["geography_version"]:
        message = (
            "geography has changed since this fixture was saved: "
            f"{metadata['geography_version']} became {current_version}"
        )
        if not allow_geography_drift:
            raise ValueError(message + "; pass --allow-geography-drift to build anyway")
        log.warning(message)

    return Prepared(
        build_id=metadata["build_id"],
        download=metadata["download"],
        inventory=restored,
        window=window,
        crop=crop,
        reference={
            "crs": grid["crs_wkt"],
            "transform": Affine(*metadata["window_transform"]),
            "width": int(crop.width),
            "height": int(crop.height),
        },
        apparent=apparent,
        air=air,
        units=metadata["units"],
        geography_version=current_version,
    )


def assemble(prepared: Prepared, config: ForecastConfig, destination: Path) -> dict:
    """Write every asset into `destination` and return a summary of sizes and counts."""
    destination.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    boundary = geo.load_boundary()

    frame = geo.load_places()
    geography_report = geo.validate_places(frame)
    if geography_report["problems"]:
        raise ValueError(f"geography validation failed: {geography_report['problems']}")
    places = geo.build_place_index(frame)

    cells = export.coverage_cells(
        prepared.reference, boundary, int(prepared.crop.row_off), int(prepared.crop.col_off)
    )
    log.info("coverage cells: %d", len(cells))

    fingerprint = prepared.inventory.grid_fingerprint()
    sizes = {"places": export.write_places(destination, places, prepared.geography_version)}
    sizes["cell_forecasts"], cell_counts = export.write_cell_forecasts(
        destination, cells, prepared.apparent, prepared.air, prepared.window.times, fingerprint
    )

    resolver = CellResolver(
        prepared.reference["crs"],
        Affine(*prepared.inventory.transform),
        prepared.inventory.width,
        prepared.inventory.height,
        window=prepared.crop,
    )
    sizes["place_cells"], mapping_counts = export.write_place_cells(
        destination,
        places,
        resolver,
        {cell.cell_id for cell in cells},
        fingerprint,
        prepared.geography_version,
    )
    sizes["grid"] = export.write_grid(
        destination, prepared.reference, prepared.inventory, prepared.crop
    )
    sizes["place_outlines"], outline_counts = export.write_place_outlines(
        destination,
        frame,
        config.display["outline_simplify_degrees"],
        config.display["coordinate_precision"],
    )
    sizes["county"] = export.write_county(
        destination,
        boundary,
        config.display["clip_simplify_degrees"],
        config.display["coordinate_precision"],
    )

    frames = export.write_frames(
        destination,
        prepared.apparent,
        prepared.reference,
        prepared.window.times,
        config.band_breaks_f,
        boundary,
        config.display["clip_simplify_degrees"],
        config.display["coordinate_precision"],
        prepared.inventory.reference_times,
    )
    sizes["frames_total"] = sum(entry["bytes"] for entry in frames)

    assets = {
        "places": "places.json",
        "cell_forecasts": "cell_forecasts.json",
        "place_cells": "place_cells.json",
        "place_outlines": "place_outlines.geojson",
        "county": "county.geojson",
        "grid": "grid.json",
        "frames_directory": "frames/",
    }
    known_slugs = {place.slug for place in places}
    unknown_labels = [slug for slug in config.display["label_places"] if slug not in known_slugs]
    if unknown_labels:
        raise ValueError(f"configured map labels are not places: {unknown_labels}")

    display = {
        "bands": export.band_legend(config.band_breaks_f, config.display["band_colors"]),
        "no_data_color": config.display["no_data_color"],
        "label_places": list(config.display["label_places"]),
    }
    sizes["manifest"] = export.write_manifest(
        destination,
        build_id=prepared.build_id,
        download=prepared.download,
        inventory=prepared.inventory,
        window=prepared.window,
        times=prepared.window.times,
        breaks=config.band_breaks_f,
        geography_version=prepared.geography_version,
        assets=assets,
        frames=frames,
        units=prepared.units,
        generated_at=datetime.now(UTC),
        display=display,
    )

    return {
        "build_id": prepared.build_id,
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "sizes": sizes,
        "counts": {
            "places": len(places),
            "reviewed_reference_points": sum(1 for p in places if p.reference_point.reviewed),
            "frames": len(frames),
            **cell_counts,
            **mapping_counts,
            **outline_counts,
        },
        "complete_24h": prepared.window.complete,
        "coverage_note": prepared.window.note,
    }


def publish(staging: Path, build_id: str, retain_days: int = 7, force: bool = False) -> Path:
    """Move a validated staging directory into place and repoint latest.json.

    A build whose id is older than the published one does not take over the pointer.
    Replaying a fixture to debug something should not roll the live forecast backwards.
    """
    BUILDS_DIR.mkdir(parents=True, exist_ok=True)
    final = BUILDS_DIR / build_id
    if final.exists():
        shutil.rmtree(final)
    staging.replace(final)

    previous = None
    if LATEST_POINTER.exists():
        previous = json.loads(LATEST_POINTER.read_text()).get("build_id")

    if previous is not None and build_id < previous and not force:
        log.warning(
            "kept %s as the published build: %s is older; pass force to override",
            previous,
            build_id,
        )
        return final

    pointer = LATEST_POINTER.with_suffix(".json.tmp")
    pointer.write_text(
        json.dumps(
            {
                "build_id": build_id,
                "manifest": f"builds/{build_id}/manifest.json",
                "published_at": iso_z(datetime.now(UTC)),
                "previous_build_id": previous,
            },
            indent=2,
        )
        + "\n"
    )
    pointer.replace(LATEST_POINTER)
    log.info("published %s", build_id)
    prune(retain_days)
    return final


def prune(retain_days: int) -> list[str]:
    """Drop builds older than the retention window, never the currently published one."""
    if not BUILDS_DIR.exists():
        return []
    current = (
        json.loads(LATEST_POINTER.read_text()).get("build_id") if LATEST_POINTER.exists() else None
    )
    cutoff = datetime.now(UTC) - timedelta(days=retain_days)
    removed = []
    for directory in sorted(BUILDS_DIR.iterdir()):
        if not directory.is_dir() or directory.name == current:
            continue
        try:
            stamp = datetime.strptime(directory.name, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        except ValueError:
            continue
        if stamp < cutoff:
            shutil.rmtree(directory)
            removed.append(directory.name)
    if removed:
        log.info("pruned %d old builds", len(removed))
    return removed


def run(
    *,
    fixture: Path | None = None,
    fetch: bool = True,
    raw: Path | None = None,
    hours: int | None = None,
    save_fixture_to: Path | None = None,
    retain_days: int = 7,
    allow_geography_drift: bool = False,
    force: bool = False,
) -> dict:
    config = load_forecast_config()
    hours = hours or config.forecast["horizon_hours"]

    if fixture is not None:
        prepared = prepare_from_fixture(fixture, allow_geography_drift)
        log.info("prepared from fixture %s", fixture)
    else:
        if raw is None and fetch:
            raw = RAW_DIR / fetch_all(config)["build_id"]
        if raw is None:
            candidates = sorted(RAW_DIR.glob("*/download.json"))
            if not candidates:
                raise SystemExit("no downloads found; run without --no-fetch first")
            raw = candidates[-1].parent
        prepared = prepare_from_source(config, raw, hours)

    if save_fixture_to is not None:
        save_fixture(prepared, save_fixture_to)

    staging = BUILD_DIR / f"{prepared.build_id}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    summary = assemble(prepared, config, staging)

    report = validate_build(staging, expected_hours=hours)
    geometry_report = validate_geometry(staging / "frames")
    report.problems.extend(geometry_report.problems)
    summary["validation"] = report.to_dict()

    if not report.ok:
        FAILED_DIR.mkdir(parents=True, exist_ok=True)
        kept = FAILED_DIR / prepared.build_id
        if kept.exists():
            shutil.rmtree(kept)
        staging.replace(kept)
        log.error("validation failed; last published build is untouched")
        for problem in report.problems:
            log.error("  %s", problem)
        raise ValidationFailed(report)

    published = publish(staging, prepared.build_id, retain_days, force=force)
    summary["path"] = str(published)
    summary["published_build_id"] = (
        json.loads(LATEST_POINTER.read_text())["build_id"] if LATEST_POINTER.exists() else None
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-fixture", type=Path, default=None)
    parser.add_argument("--save-fixture", type=Path, const=FIXTURE_DIR / "build.npz", nargs="?")
    parser.add_argument("--no-fetch", action="store_true", help="use the newest local download")
    parser.add_argument("--raw", type=Path, default=None, help="a specific download directory")
    parser.add_argument("--hours", type=int, default=None)
    parser.add_argument("--retain-days", type=int, default=7)
    parser.add_argument("--allow-geography-drift", action="store_true")
    parser.add_argument(
        "--force", action="store_true", help="publish even if it is older than the current build"
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    summary = run(
        fixture=args.from_fixture,
        fetch=not args.no_fetch,
        raw=args.raw,
        hours=args.hours,
        save_fixture_to=args.save_fixture,
        retain_days=args.retain_days,
        allow_geography_drift=args.allow_geography_drift,
        force=args.force,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
