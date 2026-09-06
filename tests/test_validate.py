"""Each check earns its place by catching a specific way the product could mislead."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import BREAKS, edit, frame_document

from feelslike_la.validate import validate_build


def problems(directory: Path, expected_hours: int | None = 2) -> str:
    return " | ".join(validate_build(directory, expected_hours=expected_hours).problems)


def test_a_good_build_passes(build: Path):
    report = validate_build(build, expected_hours=2)
    assert report.ok, report.problems
    assert report.counts == {
        "forecast_times": 2,
        "places": 1,
        "cells": 1,
        "mapped_places": 1,
        "unsupported_places": 0,
        "frames": 2,
        "band_ids_drawn": [1, 2],
        "place_outlines": 1,
    }


def test_missing_manifest_is_caught(build: Path):
    (build / "manifest.json").unlink()
    assert "manifest.json is missing" in problems(build)


def test_duplicate_slugs_are_caught(build: Path):
    edit(build / "places.json", lambda d: d["places"].append(dict(d["places"][0])))
    assert "duplicate slugs" in problems(build)


def test_a_non_finite_reference_point_is_caught(build: Path):
    edit(
        build / "places.json",
        lambda d: d["places"][0]["reference_point"].update({"longitude": None}),
    )
    assert "non-finite reference point" in problems(build)


def test_an_out_of_range_reference_point_is_caught(build: Path):
    edit(
        build / "places.json",
        lambda d: d["places"][0]["reference_point"].update({"latitude": 91.0}),
    )
    assert "outside valid coordinates" in problems(build)


def test_a_short_series_is_caught(build: Path):
    """A series shorter than its time index would silently shift every later hour."""
    edit(build / "cell_forecasts.json", lambda d: d["cells"][0]["temperature_f"].pop())
    assert "1 values for 2 forecast times" in problems(build)


def test_a_nan_in_a_series_is_caught(build: Path):
    """NaN is not valid JSON and reads as a number in some clients."""
    path = build / "cell_forecasts.json"
    path.write_text(path.read_text().replace("65.03", "NaN", 1))
    assert "non-standard constant" in problems(build)


def test_missing_values_may_be_null(build: Path):
    """Null is the correct representation of an unavailable forecast."""
    edit(
        build / "cell_forecasts.json",
        lambda d: d["cells"][0].update({"temperature_f": [None, 70.07]}),
    )
    assert validate_build(build, expected_hours=2).ok


def test_a_missing_hour_is_caught(build: Path):
    def drop_second_hour(document):
        document["forecast_times"] = [document["forecast_times"][0]]
        document["frames"] = [document["frames"][0]]

    edit(build / "manifest.json", drop_second_hour)
    edit(build / "cell_forecasts.json", lambda d: d.update({"forecast_times": d["forecast_times"][:1]}))
    assert "complete_24h is True but the build has 1 hours" in problems(build)


def test_a_gap_in_the_hours_is_caught(build: Path):
    """Three-hourly forecasts must never be presented as consecutive hours."""
    def skip_an_hour(document):
        document["forecast_times"][1] = "2026-09-06T23:00:00Z"
        document["frames"][1]["valid_time"] = "2026-09-06T23:00:00Z"

    edit(build / "manifest.json", skip_an_hour)
    edit(
        build / "cell_forecasts.json",
        lambda d: d["forecast_times"].__setitem__(1, "2026-09-06T23:00:00Z"),
    )
    assert "not consecutive hours" in problems(build)


def test_times_must_be_utc(build: Path):
    def localize(document):
        document["forecast_times"][1] = "2026-09-06T14:00:00-07:00"
        document["frames"][1]["valid_time"] = "2026-09-06T14:00:00-07:00"

    edit(build / "manifest.json", localize)
    assert "must be UTC" in problems(build)


def test_an_unsupported_source_unit_is_caught(build: Path):
    edit(
        build / "manifest.json",
        lambda d: d["source_files"][0].update({"declared_unit": "degrees"}),
    )
    assert "unconvertible unit" in problems(build)


def test_a_wrong_output_unit_is_caught(build: Path):
    edit(build / "manifest.json", lambda d: d.update({"temperature_unit": "degC"}))
    assert "unsupported temperature unit" in problems(build)


def test_unsorted_breaks_are_caught(build: Path):
    edit(build / "manifest.json", lambda d: d.update({"band_breaks_f": [65.0, 60.0, 70.0]}))
    assert "strictly ascending" in problems(build)


def test_a_mismatched_grid_fingerprint_is_caught(build: Path):
    """A place-cell mapping is only valid for the grid it was built against."""
    edit(build / "place_cells.json", lambda d: d.update({"grid_fingerprint": "sha256:other"}))
    assert "different grid fingerprint" in problems(build)


def test_a_mismatched_geography_version_is_caught(build: Path):
    edit(build / "places.json", lambda d: d.update({"geography_version": "sha256:older"}))
    assert "geography_version does not match" in problems(build)


def test_a_mapping_pointing_at_an_unknown_cell_is_caught(build: Path):
    edit(
        build / "place_cells.json",
        lambda d: d["places"]["del-rey"].update({"cell_id": "r1c1"}),
    )
    assert "no forecast series" in problems(build)


def test_a_place_missing_from_the_mapping_is_caught(build: Path):
    edit(build / "place_cells.json", lambda d: d["places"].clear())
    assert "absent from the mapping" in problems(build)


def test_an_unsupported_place_must_state_a_reason(build: Path):
    edit(build / "place_cells.json", lambda d: d["places"]["del-rey"].update({"cell_id": None}))
    assert "no cell and no stated reason" in problems(build)


def test_an_unsupported_place_with_a_reason_passes(build: Path):
    """Places outside coverage are surfaced, not dropped."""
    edit(
        build / "place_cells.json",
        lambda d: d["places"]["del-rey"].update(
            {"cell_id": None, "unsupported_reason": "outside published coverage"}
        ),
    )
    report = validate_build(build, expected_hours=2)
    assert report.ok, report.problems
    assert report.counts["unsupported_places"] == 1


def test_a_missing_frame_file_is_caught(build: Path):
    (build / "frames" / "2026090620" "00Z.geojson").unlink()
    assert "missing its file" in problems(build)


def test_a_frame_count_mismatch_is_caught(build: Path):
    edit(build / "manifest.json", lambda d: d["frames"].pop())
    assert "1 frames for 2 forecast times" in problems(build)


def test_frame_bounds_inconsistent_with_the_class_are_caught(build: Path):
    """A band drawn as 60-65 must not be labeled 65-70, or the legend lies."""
    path = build / "frames" / "2026090620" "00Z.geojson"
    document = json.loads(path.read_text())
    document["features"][0]["properties"]["upper_f"] = 70.0
    path.write_text(json.dumps(document))
    assert "declares bounds" in problems(build)


def test_an_out_of_range_band_id_is_caught(build: Path):
    path = build / "frames" / "2026090620" "00Z.geojson"
    document = frame_document(1)
    document["features"][0]["properties"]["band_id"] = len(BREAKS) + 5
    path.write_text(json.dumps(document))
    assert "out-of-range band_id" in problems(build)


def test_an_empty_frame_is_caught(build: Path):
    path = build / "frames" / "2026090620" "00Z.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": []}))
    assert "has no features" in problems(build)


def test_a_frame_whose_size_changed_is_caught(build: Path):
    """The manifest describes the bytes that were published."""
    path = build / "frames" / "2026090620" "00Z.geojson"
    path.write_text(path.read_text() + " ")
    assert "size does not match the manifest" in problems(build)


def test_a_non_polygon_frame_geometry_is_caught(build: Path):
    path = build / "frames" / "2026090620" "00Z.geojson"
    document = json.loads(path.read_text())
    document["features"][0]["geometry"] = {"type": "Point", "coordinates": [-118.3, 34.0]}
    path.write_text(json.dumps(document))
    edit(
        build / "manifest.json",
        lambda d: d["frames"][0].update({"bytes": path.stat().st_size}),
    )
    assert "geometry" in problems(build)


def test_a_missing_legend_is_caught(build: Path):
    edit(build / "manifest.json", lambda d: d.pop("display"))
    assert "no display band legend" in problems(build)


def test_a_legend_that_skips_a_class_is_caught(build: Path):
    """Fourteen classes need fourteen colors, or the hottest band draws as no data."""
    edit(build / "manifest.json", lambda d: d["display"]["bands"].pop())
    assert "legend entries" in problems(build)


def test_a_legend_whose_bounds_drift_is_caught(build: Path):
    edit(build / "manifest.json", lambda d: d["display"]["bands"][1].update({"lower_f": 61.0}))
    assert "legend band 1 declares bounds" in problems(build)


def test_two_classes_sharing_a_color_are_caught(build: Path):
    edit(
        build / "manifest.json",
        lambda d: d["display"]["bands"][2].update({"color": d["display"]["bands"][1]["color"]}),
    )
    assert "share a color" in problems(build)


def test_a_no_data_gray_that_looks_like_a_band_is_caught(build: Path):
    """The real mistake this catches: #e5e5e4 beside a #dfe9e4 mild band.

    Four points apart in Lab, which is indistinguishable on a phone, so missing data
    would have read as a mild afternoon rather than as missing.
    """
    edit(build / "manifest.json", lambda d: d["display"].update({"no_data_color": "#e5e5e4"}))
    edit(build / "manifest.json", lambda d: d["display"]["bands"][1].update({"color": "#dfe9e4"}))
    assert "read as missing rather than mild" in problems(build)


def test_two_neighboring_classes_too_close_to_tell_apart_are_caught(build: Path):
    edit(build / "manifest.json", lambda d: d["display"]["bands"][1].update({"color": "#3f6fa9"}))
    assert "too close to read as different temperatures" in problems(build)


def test_a_label_naming_an_unknown_place_is_caught(build: Path):
    edit(build / "manifest.json", lambda d: d["display"].update({"label_places": ["atlantis"]}))
    assert "map labels name places absent" in problems(build)


def test_a_class_drawn_with_no_color_is_caught(build: Path):
    """A frame may only draw classes the legend can color."""

    def renumber(document: dict) -> None:
        document["display"]["bands"][2]["band_id"] = 9

    edit(build / "manifest.json", renumber)
    assert "no color for" in problems(build)


def test_a_place_with_no_outline_is_caught(build: Path):
    edit(build / "place_outlines.geojson", lambda d: d["features"].clear())
    assert "places with no outline to draw" in problems(build)


def test_an_outline_for_an_unknown_place_is_caught(build: Path):
    edit(
        build / "place_outlines.geojson",
        lambda d: d["features"].append(
            {**d["features"][0], "properties": {"slug": "atlantis", "name": "Atlantis"}}
        ),
    )
    assert "outlines for places absent from the index" in problems(build)


def test_a_missing_outline_file_is_caught(build: Path):
    (build / "place_outlines.geojson").unlink()
    assert "place_outlines.geojson is missing" in problems(build)


def test_a_missing_county_file_is_caught(build: Path):
    (build / "county.geojson").unlink()
    assert "county.geojson is missing" in problems(build)


def test_a_county_split_into_several_features_is_caught(build: Path):
    """One dissolved polygon, so the map's no-data fill cannot have seams in it."""
    edit(build / "county.geojson", lambda d: d["features"].append(dict(d["features"][0])))
    assert "features, expected one" in problems(build)
