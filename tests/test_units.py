"""Unit conversion and nodata propagation."""

from __future__ import annotations

import numpy as np
import pytest

from feelslike_la.grid import UnsupportedUnit, to_fahrenheit


def test_celsius_to_fahrenheit():
    values = np.array([-40.0, 0.0, 37.0, 100.0])
    assert np.allclose(to_fahrenheit(values, "degC"), [-40.0, 32.0, 98.6, 212.0])


def test_kelvin_to_fahrenheit():
    assert to_fahrenheit(np.array([273.15]), "kelvin")[0] == pytest.approx(32.0)


def test_fahrenheit_passes_through():
    values = np.array([71.5])
    assert to_fahrenheit(values, "degF")[0] == 71.5


def test_nodata_stays_missing():
    """A converted NaN must remain NaN rather than becoming a plausible temperature."""
    values = np.array([20.0, np.nan, 25.0])
    converted = to_fahrenheit(values, "degC")
    assert np.isnan(converted[1])
    assert np.isfinite(converted[[0, 2]]).all()


def test_unknown_unit_raises():
    """Never guess a unit from value magnitudes."""
    with pytest.raises(UnsupportedUnit):
        to_fahrenheit(np.array([20.0]), "degrees")
