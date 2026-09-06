"""Spot-check helper for the NWS API gridpoint endpoint.

This is a comparison route, not the product's data source. It exists so bulk-decoded
NDFD values can be checked against another representation of the same forecast.

Interval expansion is not interpolation: a value stamped `.../PT3H` is one forecast
value the API declares as covering three hours, so it repeats across those hours.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import requests

from .config import USER_AGENT

POINTS_URL = "https://api.weather.gov/points/{latitude},{longitude}"
DURATION = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)

UNIT_NAMES = {
    "wmoUnit:degC": "degC",
    "wmoUnit:degF": "degF",
    "wmoUnit:K": "kelvin",
}


def parse_duration(text: str) -> timedelta:
    match = DURATION.match(text)
    if not match:
        raise ValueError(f"unsupported ISO 8601 duration {text!r}")
    parts = {key: int(value) for key, value in match.groupdict(default="0").items()}
    return timedelta(
        days=parts["days"],
        hours=parts["hours"],
        minutes=parts["minutes"],
        seconds=parts["seconds"],
    )


def expand_intervals(values: list[dict], unit: str) -> dict[datetime, float | None]:
    """Expand `validTime` intervals into one entry per hour they cover."""
    expanded: dict[datetime, float | None] = {}
    for entry in values:
        stamp, _, duration = entry["validTime"].partition("/")
        start = datetime.fromisoformat(stamp).astimezone(UTC)
        span = parse_duration(duration)
        hours = max(1, int(span.total_seconds() // 3600))
        for step in range(hours):
            expanded[start + timedelta(hours=step)] = _to_fahrenheit(entry["value"], unit)
    return expanded


def _to_fahrenheit(value: float | None, unit: str) -> float | None:
    if value is None:
        return None
    name = UNIT_NAMES.get(unit)
    if name == "degF":
        return float(value)
    if name == "degC":
        return float(value) * 9 / 5 + 32
    if name == "kelvin":
        return (float(value) - 273.15) * 9 / 5 + 32
    raise ValueError(f"unexpected API unit {unit!r}")


def gridpoint(longitude: float, latitude: float, timeout: float = 30) -> dict:
    """Fetch the raw gridpoint forecast covering a coordinate."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json"}
    points = requests.get(
        POINTS_URL.format(latitude=round(latitude, 4), longitude=round(longitude, 4)),
        headers=headers,
        timeout=timeout,
    )
    points.raise_for_status()
    grid_url = points.json()["properties"]["forecastGridData"]

    grid = requests.get(grid_url, headers=headers, timeout=timeout)
    grid.raise_for_status()
    payload = grid.json()["properties"]

    result = {
        "grid_url": grid_url,
        "grid_id": payload.get("gridId"),
        "grid_x": payload.get("gridX"),
        "grid_y": payload.get("gridY"),
        "update_time": payload.get("updateTime"),
        "valid_times": payload.get("validTimes"),
    }
    for field in ("apparentTemperature", "temperature"):
        block = payload.get(field) or {}
        result[field] = expand_intervals(block.get("values", []), block.get("uom", ""))
    return result
