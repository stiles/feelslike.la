"""Forecast hour selection and local labeling, including daylight-saving transitions."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from feelslike_la.times import local_label, select_hourly_window, utc_key


def hours(start: str, count: int, step: int = 1) -> list[datetime]:
    first = datetime.fromisoformat(start).replace(tzinfo=UTC)
    return [first + timedelta(hours=step * index) for index in range(count)]


def test_window_starts_at_first_hour_at_or_after_now():
    times = hours("2026-09-06T18:00", 30)
    window = select_hourly_window(times, now=datetime(2026, 9, 6, 20, 42, tzinfo=UTC))
    assert window.first == datetime(2026, 9, 6, 20, 0, tzinfo=UTC)
    assert window.complete
    assert len(window.times) == 24


def test_window_stops_at_a_gap_instead_of_stitching_coarse_hours():
    """The product must not present a three-hourly tail as consecutive hourly forecasts."""
    times = hours("2026-09-06T20:00", 12) + hours("2026-09-07T11:00", 6, step=3)
    window = select_hourly_window(times, now=datetime(2026, 9, 6, 20, 0, tzinfo=UTC))
    assert len(window.times) == 12
    assert not window.complete
    assert "only 12" in window.note


def test_window_is_empty_when_every_hour_is_in_the_past():
    times = hours("2026-09-05T00:00", 24)
    window = select_hourly_window(times, now=datetime(2026, 9, 6, 20, 0, tzinfo=UTC))
    assert window.times == []
    assert not window.complete


def test_fall_back_repeats_a_local_hour_with_distinct_instants():
    """Nov. 1, 2026: 1 a.m. happens twice locally, so labels must carry the offset."""
    first = datetime(2026, 11, 1, 8, 0, tzinfo=UTC)
    second = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
    assert local_label(first) == "Sun 1 am PDT"
    assert local_label(second) == "Sun 1 am PST"
    assert utc_key(first) != utc_key(second)


def test_spring_forward_skips_a_local_hour():
    """March 8, 2026: 2 a.m. local does not exist, so 9:00Z lands on 1 a.m. and 10:00Z on 3 a.m."""
    assert local_label(datetime(2026, 3, 8, 9, 0, tzinfo=UTC)) == "Sun 1 am PST"
    assert local_label(datetime(2026, 3, 8, 10, 0, tzinfo=UTC)) == "Sun 3 am PDT"


def test_run_times_keep_their_minutes():
    """NDFD runs are issued on the half hour; dropping minutes misstates the run."""
    reference = datetime(2026, 9, 6, 19, 30, tzinfo=UTC)
    assert local_label(reference, with_minutes=True) == "Sun 12:30 pm PDT"
