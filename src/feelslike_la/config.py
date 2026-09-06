"""Project paths and configuration loading."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
BUILD_DIR = ROOT / "build"
DOCS_DIR = ROOT / "docs"

USER_AGENT = "feelslike.la prototype (contact: mattstiles@gmail.com)"


@dataclass(frozen=True)
class Coverage:
    min_longitude: float
    max_longitude: float
    min_latitude: float
    max_latitude: float
    buffer_cells: int

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """Return (west, south, east, north)."""
        return (
            self.min_longitude,
            self.min_latitude,
            self.max_longitude,
            self.max_latitude,
        )


@dataclass(frozen=True)
class ForecastConfig:
    raw: dict[str, Any]

    @property
    def source(self) -> dict[str, Any]:
        return self.raw["source"]

    @property
    def elements(self) -> dict[str, str]:
        return self.raw["source"]["elements"]

    @property
    def download(self) -> dict[str, Any]:
        return self.raw["download"]

    @property
    def forecast(self) -> dict[str, Any]:
        return self.raw["forecast"]

    @property
    def display(self) -> dict[str, Any]:
        return self.raw["display"]

    @property
    def band_breaks_f(self) -> list[float]:
        return [float(v) for v in self.raw["forecast"]["band_breaks_f"]]

    @property
    def coverage(self) -> Coverage:
        return Coverage(**self.raw["coverage"])

    def element_url(self, element: str) -> str:
        s = self.source
        return f"{s['base_url']}/opnl/{s['sector']}/{s['period']}/{self.elements[element]}"


def load_forecast_config(path: Path | None = None) -> ForecastConfig:
    path = path or CONFIG_DIR / "forecast.toml"
    with path.open("rb") as fh:
        return ForecastConfig(tomllib.load(fh))
