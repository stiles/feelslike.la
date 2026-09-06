"""A minimal valid build on disk, for tests that need one to break."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

BREAKS = [60.0, 65.0, 70.0]
TIMES = ["2026-09-06T20:00:00Z", "2026-09-06T21:00:00Z"]


def square(west: float, south: float, size: float = 0.1) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [west + size, south],
                [west + size, south + size],
                [west, south + size],
                [west, south],
            ]
        ],
    }


def frame_document(band_id: int) -> dict:
    lower = None if band_id == 0 else BREAKS[band_id - 1]
    upper = None if band_id >= len(BREAKS) else BREAKS[band_id]
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "band_id": band_id,
                    "lower_f": lower,
                    "upper_f": upper,
                    "observed_min_f": 61.0,
                    "observed_max_f": 64.0,
                },
                "geometry": square(-118.3, 34.0),
            }
        ],
    }


@pytest.fixture
def build(tmp_path: Path) -> Path:
    """Write a small build that passes validation, so tests can invalidate one thing."""
    directory = tmp_path / "20260906T200000Z"
    (directory / "frames").mkdir(parents=True)

    frames = []
    for index, valid_time in enumerate(TIMES):
        name = f"2026090620{index}0Z.geojson"
        path = directory / "frames" / name
        path.write_text(json.dumps(frame_document(1 + index)))
        frames.append(
            {
                "valid_time": valid_time,
                "path": f"frames/{name}",
                "bytes": path.stat().st_size,
                "checksum": "sha256:unchecked",
                "band_ids": [1 + index],
                "feature_count": 1,
                "source_reference_times": ["2026-09-06T19:30:00Z"],
            }
        )

    write(directory / "places.json", {
        "schema_version": 1,
        "geography_version": "sha256:geo",
        "place_count": 1,
        "places": [
            {
                "slug": "del-rey",
                "name": "Del Rey",
                "region": "westside",
                "source_type": "segment-of-a-city",
                "city": "los-angeles",
                "area_sqmi": 2.45,
                "reference_point": {
                    "longitude": -118.422,
                    "latitude": 33.9892,
                    "method": "polylabel_largest_part",
                    "reviewed": True,
                    "review_note": None,
                },
                "aliases": [],
            }
        ],
    })

    write(directory / "cell_forecasts.json", {
        "schema_version": 1,
        "grid_fingerprint": "sha256:grid",
        "temperature_unit": "degF",
        "forecast_times": TIMES,
        "cell_count": 1,
        "cells": [
            {
                "cell_id": "r803c231",
                "longitude": -118.4242,
                "latitude": 33.9818,
                "temperature_f": [65.03, 70.07],
                "apparent_temperature_f": [65.03, 70.07],
            }
        ],
    })

    write(directory / "place_cells.json", {
        "schema_version": 1,
        "grid_fingerprint": "sha256:grid",
        "geography_version": "sha256:geo",
        "mapping_version": "sha256:mapping",
        "places": {
            "del-rey": {
                "reference_point": [-118.422, 33.9892],
                "reference_method": "polylabel_largest_part",
                "reviewed": True,
                "cell_id": "r803c231",
            }
        },
    })

    write(directory / "manifest.json", {
        "schema_version": 1,
        "build_id": "20260906T200000Z",
        "generated_at": "2026-09-06T19:55:00Z",
        "retrieved_at": "2026-09-06T19:40:25Z",
        "provider": "NWS NDFD",
        "source_files": [
            {
                "element": "apparent_temperature",
                "url": "https://example.invalid/ds.apt.bin",
                "bytes": 1,
                "sha256": "abc",
                "retrieved_at": "2026-09-06T19:40:25Z",
                "last_modified": None,
                "declared_unit": "degC",
            }
        ],
        "geography_version": "sha256:geo",
        "grid_fingerprint": "sha256:grid",
        "timezone": "America/Los_Angeles",
        "temperature_unit": "degF",
        "band_breaks_f": BREAKS,
        "forecast_reference_times": ["2026-09-06T19:30:00Z"],
        "forecast_times": TIMES,
        "requested_hours": 2,
        "complete_24h": True,
        "assets": {
            "places": "places.json",
            "cell_forecasts": "cell_forecasts.json",
            "place_cells": "place_cells.json",
            "grid": "grid.json",
            "frames_directory": "frames/",
        },
        "frames": frames,
    })
    return directory


def write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2))


def edit(path: Path, mutate) -> None:
    """Load JSON, hand it to `mutate`, write it back."""
    document = json.loads(path.read_text())
    mutate(document)
    write(path, document)
