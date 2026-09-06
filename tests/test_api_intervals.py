"""NWS API interval expansion, which is repetition and not interpolation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from feelslike_la.nws_api import expand_intervals, parse_duration


def test_parse_duration_hours_and_days():
    assert parse_duration("PT1H") == timedelta(hours=1)
    assert parse_duration("PT6H") == timedelta(hours=6)
    assert parse_duration("P1DT3H") == timedelta(days=1, hours=3)


def test_unsupported_duration_raises():
    with pytest.raises(ValueError, match="duration"):
        parse_duration("3 hours")


def test_a_three_hour_interval_repeats_its_value():
    """The API declares one value covering three hours. Each hour gets that same value."""
    values = [{"validTime": "2026-09-06T20:00:00+00:00/PT3H", "value": 20.0}]
    expanded = expand_intervals(values, "wmoUnit:degC")
    assert len(expanded) == 3
    assert set(expanded.values()) == {68.0}
    assert expanded[datetime(2026, 9, 6, 21, tzinfo=UTC)] == 68.0


def test_expansion_does_not_interpolate_between_intervals():
    """Values must not ramp between two declared intervals."""
    values = [
        {"validTime": "2026-09-06T20:00:00+00:00/PT2H", "value": 20.0},
        {"validTime": "2026-09-06T22:00:00+00:00/PT2H", "value": 30.0},
    ]
    expanded = expand_intervals(values, "wmoUnit:degC")
    assert expanded[datetime(2026, 9, 6, 21, tzinfo=UTC)] == 68.0
    assert expanded[datetime(2026, 9, 6, 22, tzinfo=UTC)] == 86.0
    assert sorted(set(expanded.values())) == [68.0, 86.0]


def test_null_values_stay_null():
    values = [{"validTime": "2026-09-06T20:00:00+00:00/PT1H", "value": None}]
    assert expand_intervals(values, "wmoUnit:degC") == {
        datetime(2026, 9, 6, 20, tzinfo=UTC): None
    }


def test_unexpected_api_unit_raises():
    values = [{"validTime": "2026-09-06T20:00:00+00:00/PT1H", "value": 20.0}]
    with pytest.raises(ValueError, match="unit"):
        expand_intervals(values, "wmoUnit:percent")
