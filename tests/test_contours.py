"""Contour class assignment, threshold edges and nodata holes."""

from __future__ import annotations

import numpy as np
import pytest
from affine import Affine

from feelslike_la.contours import band_id_for, build_bands, field_to_dataarray

BREAKS = [50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0]
TRANSFORM = Affine(2539.703, 0.0, -2_200_000.0, 0.0, -2539.703, 1_250_000.0)
CRS = (
    "+proj=lcc +lat_1=25 +lat_2=25 +lat_0=25 +lon_0=-95 +x_0=0 +y_0=0 "
    "+a=6371200 +b=6371200 +units=m +no_defs"
)
REFERENCE = {"crs": CRS, "transform": TRANSFORM, "width": 8, "height": 8}


def gradient_field(low: float = 58.0, high: float = 82.0) -> np.ndarray:
    return np.tile(np.linspace(low, high, 8), (8, 1))


def test_intervals_are_lower_inclusive():
    """A value exactly on a threshold belongs to the class above it, not below.

    Class 4 is [65, 70) and class 5 is [70, 75), so 70.0 lands in class 5.
    """
    assert band_id_for(69.999, BREAKS) == 4
    assert band_id_for(70.0, BREAKS) == 5
    assert band_id_for(70.001, BREAKS) == 5


def test_open_ended_classes_at_both_extremes():
    assert band_id_for(-10.0, BREAKS) == 0
    assert band_id_for(45.0, BREAKS) == 0
    assert band_id_for(120.0, BREAKS) == len(BREAKS)


def test_dataarray_carries_projected_cell_centers():
    data = field_to_dataarray(gradient_field(), TRANSFORM)
    assert data.dims == ("y", "x")
    # Cell centers, so half a cell in from the origin.
    assert data.x.values[0] == pytest.approx(-2_200_000.0 + 2539.703 / 2)
    assert data.y.values[0] == pytest.approx(1_250_000.0 - 2539.703 / 2)


def test_bands_cover_every_class_the_field_touches():
    bands = build_bands(gradient_field(), REFERENCE, BREAKS)
    assert bands.crs.to_epsg() == 4326
    # A 58-to-82 degree field spans [55, 60) through the open class above 80.
    assert set(bands["band_id"]) == {2, 3, 4, 5, 6, 7}
    assert bands.geometry.is_valid.all()


def test_the_top_class_is_open_ended_and_keeps_the_observed_maximum():
    bands = build_bands(gradient_field(), REFERENCE, BREAKS)
    top = bands[bands["band_id"] == len(BREAKS)].iloc[0]
    assert top["lower_f"] == BREAKS[-1]
    assert top["upper_f"] is None
    assert top["observed_max_f"] == pytest.approx(82.0)


def test_a_value_equal_to_the_final_threshold_is_not_dropped():
    """A field maxing out exactly on the last break keeps that region.

    When the maximum equals a threshold, no area lies above it, so the class below
    closes at the maximum rather than an empty top class appearing. What matters is
    that the region is still covered and the observed maximum is reported.
    """
    field = np.full((8, 8), 70.0)
    field[4:, :] = 80.0
    bands = build_bands(field, REFERENCE, BREAKS)
    assert bands["observed_max_f"].max() == pytest.approx(80.0)
    covered = bands.geometry.union_all().area
    reference = build_bands(gradient_field(), REFERENCE, BREAKS).geometry.union_all().area
    assert covered == pytest.approx(reference, rel=0.01)


def test_a_constant_field_returns_one_covering_class():
    bands = build_bands(np.full((8, 8), 72.5), REFERENCE, BREAKS)
    assert len(bands) == 1
    assert bands.iloc[0]["band_id"] == 5


def test_nodata_cells_leave_a_hole_rather_than_a_temperature():
    field = gradient_field()
    field[3:5, 3:5] = np.nan
    with_hole = build_bands(field, REFERENCE, BREAKS)
    without_hole = build_bands(gradient_field(), REFERENCE, BREAKS)
    assert with_hole.geometry.union_all().area < without_hole.geometry.union_all().area


def test_an_entirely_missing_field_raises_instead_of_publishing_nothing():
    with pytest.raises(ValueError, match="no finite values"):
        build_bands(np.full((8, 8), np.nan), REFERENCE, BREAKS)


def test_class_boundaries_do_not_shift_with_the_data():
    """The same class must mean the same temperatures in a cool frame and a hot one."""
    cool = build_bands(gradient_field(52.0, 68.0), REFERENCE, BREAKS)
    hot = build_bands(gradient_field(72.0, 88.0), REFERENCE, BREAKS)
    shared = set(cool["band_id"]) & set(hot["band_id"])
    for band_id in shared:
        cool_row = cool[cool["band_id"] == band_id].iloc[0]
        hot_row = hot[hot["band_id"] == band_id].iloc[0]
        assert cool_row["lower_f"] == hot_row["lower_f"]
        assert cool_row["upper_f"] == hot_row["upper_f"]


def test_the_palette_must_cover_every_class():
    """One color per class, including both open-ended ones.

    A palette one short leaves the hottest class with no color, which the map would draw
    in the no-data gray: the hottest hour of the year rendered as missing data.
    """
    import pytest

    from feelslike_la.export import band_legend

    breaks = [60.0, 65.0, 70.0]
    legend = band_legend(breaks, ["#3f6fa8", "#bfd6e6", "#f8c86e", "#cd4322"])
    assert [entry["band_id"] for entry in legend] == [0, 1, 2, 3]
    assert legend[0]["lower_f"] is None and legend[0]["label"] == "Below 60°"
    assert legend[-1]["upper_f"] is None and legend[-1]["label"] == "70° and above"

    with pytest.raises(ValueError, match="one color per class"):
        band_legend(breaks, ["#3f6fa8", "#bfd6e6", "#f8c86e"])
