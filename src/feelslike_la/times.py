"""Forecast time selection and labeling.

Timestamps are stored in UTC and displayed in America/Los_Angeles. Retrieval time,
build time, forecast reference time and valid time are separate concepts and are
never collapsed into one "now."
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

LOS_ANGELES = ZoneInfo("America/Los_Angeles")


def utc_key(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y%m%dT%H%MZ")


def iso_z(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def local_label(moment: datetime, with_minutes: bool = False) -> str:
    """Local label including the offset, which disambiguates repeated fall-back hours.

    Forecast valid times land on the hour; run times do not, so anything labeling a
    reference time needs the minutes or a 19:30Z run reads as noon.
    """
    local = moment.astimezone(LOS_ANGELES)
    pattern = "%-I:%M %p" if with_minutes else "%-I %p"
    return f"{local.strftime('%a')} {local.strftime(pattern).lower()} {local.tzname()}"


@dataclass
class HourlyWindow:
    times: list[datetime]
    complete: bool
    requested_hours: int
    note: str

    @property
    def first(self) -> datetime:
        return self.times[0]

    @property
    def last(self) -> datetime:
        return self.times[-1]


def select_hourly_window(
    valid_times: list[datetime],
    now: datetime | None = None,
    hours: int = 24,
) -> HourlyWindow:
    """Take up to `hours` consecutive hourly valid times at or after `now`.

    The first selected hour is the first available valid time at or after now. It is a
    forecast for that hour, not an observation of the current conditions. The run stops
    at the first gap rather than stitching across a coarser part of the product.
    """
    now = (now or datetime.now(UTC)).astimezone(UTC)
    ordered = sorted(valid_times)
    upcoming = [t for t in ordered if t >= now.replace(minute=0, second=0, microsecond=0)]
    if not upcoming:
        return HourlyWindow([], False, hours, "no valid times at or after now")

    run = [upcoming[0]]
    for moment in upcoming[1:]:
        if moment - run[-1] != timedelta(hours=1):
            break
        run.append(moment)
        if len(run) == hours:
            break

    complete = len(run) == hours
    if complete:
        note = f"{hours} consecutive hourly valid times"
    else:
        note = (
            f"only {len(run)} consecutive hourly valid times available from "
            f"{iso_z(run[0])}; hourly coverage ends at {iso_z(run[-1])}"
        )
    return HourlyWindow(run, complete, hours, note)
