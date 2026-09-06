"""Load la-geography places and build reference points.

Source: https://github.com/stiles/la-geography, whose countywide layer derives from
the Los Angeles Times' Mapping LA project. Full polygons are authoritative for
assignments; the simplified export is for display.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
from dataclasses import asdict, dataclass
from pathlib import Path

import geopandas as gpd
import requests
from shapely.geometry import Point
from shapely.ops import polylabel

from .config import CONFIG_DIR, DATA_DIR, USER_AGENT

log = logging.getLogger(__name__)

GEOGRAPHY_DIR = DATA_DIR / "geography"
BASE_URL = "https://stilesdata.com/la-geography"
FULL_NAME = "la_neighborhoods_comprehensive.geojson"
SIMPLIFIED_NAME = "la_neighborhoods_comprehensive_simplified.geojson"
BOUNDARY_NAME = "la_county_boundary.geojson"

# Full polygons are authoritative for place assignment, the simplified export is for
# display, and the county boundary is the display coverage the contours are clipped to.
LAYERS = (FULL_NAME, SIMPLIFIED_NAME, BOUNDARY_NAME)

# Degrees. Roughly 50 m at this latitude: fine enough to stay off polygon edges,
# coarse enough that polylabel converges quickly on complex coastlines.
POLYLABEL_TOLERANCE = 0.0005

PROTOTYPE_SLUGS = (
    "del-rey",
    "santa-monica",
    "downtown",
    "pasadena",
    "woodland-hills",
    "lancaster",
)


@dataclass
class ReferencePoint:
    longitude: float
    latitude: float
    method: str
    reviewed: bool
    review_note: str | None = None


@dataclass
class Place:
    slug: str
    name: str
    region: str
    source_type: str
    city: str | None
    area_sqmi: float
    reference_point: ReferencePoint
    aliases: list[str]


def download_geography(force: bool = False) -> dict[str, Path]:
    GEOGRAPHY_DIR.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name in LAYERS:
        path = GEOGRAPHY_DIR / name
        if force or not path.exists():
            response = requests.get(
                f"{BASE_URL}/{name}", timeout=120, headers={"User-Agent": USER_AGENT}
            )
            response.raise_for_status()
            path.write_bytes(response.content)
            log.info("downloaded %s (%.1f MB)", name, len(response.content) / 1e6)
        paths[name] = path
    return paths


def load_boundary(path: Path | None = None):
    """The county boundary used as display coverage for clipping contours."""
    return gpd.read_file(path or GEOGRAPHY_DIR / BOUNDARY_NAME)


def geography_version(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load_places(path: Path | None = None) -> gpd.GeoDataFrame:
    path = path or GEOGRAPHY_DIR / FULL_NAME
    frame = gpd.read_file(path)
    if frame.crs is None or frame.crs.to_epsg() != 4326:
        raise ValueError(f"expected EPSG:4326 geography, got {frame.crs}")
    return frame


def validate_places(frame: gpd.GeoDataFrame) -> dict:
    """Checks that must pass before a place index is published."""
    duplicates = sorted(frame.loc[frame["slug"].duplicated(keep=False), "slug"].unique())
    problems = []
    if duplicates:
        problems.append(f"duplicate slugs: {duplicates}")
    if frame["slug"].isna().any() or (frame["slug"].astype(str).str.len() == 0).any():
        problems.append("empty slug values")
    invalid = int((~frame.geometry.is_valid).sum())
    if invalid:
        problems.append(f"{invalid} invalid geometries")
    if frame.geometry.is_empty.any():
        problems.append("empty geometries")
    return {
        "count": len(frame),
        "duplicate_slugs": duplicates,
        "invalid_geometries": invalid,
        "bounds": [round(v, 6) for v in frame.total_bounds],
        "types": frame["type"].value_counts().to_dict(),
        "problems": problems,
    }


def interior_point(geometry) -> tuple[Point, str]:
    """Pole of inaccessibility of the largest part, falling back to a representative point."""
    parts = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    largest = max(parts, key=lambda part: part.area)
    try:
        candidate = polylabel(largest, tolerance=POLYLABEL_TOLERANCE)
        if geometry.covers(candidate):
            return candidate, "polylabel_largest_part"
    except Exception as error:  # noqa: BLE001 - shapely raises assorted geometry errors
        log.warning("polylabel failed (%s); using representative point", error)
    return geometry.representative_point(), "representative_point"


def load_overrides(path: Path | None = None) -> dict[str, dict]:
    path = path or CONFIG_DIR / "place_overrides.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text()).get("places", {})


def build_place_index(
    frame: gpd.GeoDataFrame | None = None,
    overrides: dict[str, dict] | None = None,
) -> list[Place]:
    frame = frame if frame is not None else load_places()
    overrides = overrides if overrides is not None else load_overrides()
    places: list[Place] = []

    for row in frame.itertuples():
        override = overrides.get(row.slug, {})
        if "longitude" in override and "latitude" in override:
            point = Point(override["longitude"], override["latitude"])
            method = "manual_override"
            if not row.geometry.covers(point):
                raise ValueError(f"override point for {row.slug} falls outside its polygon")
        else:
            point, method = interior_point(row.geometry)

        city = row.city if isinstance(row.city, str) and row.city else None
        places.append(
            Place(
                slug=row.slug,
                name=row.name,
                region=row.region,
                source_type=row.type,
                city=city,
                area_sqmi=round(float(row.area_sqmi), 4),
                reference_point=ReferencePoint(
                    longitude=round(point.x, 6),
                    latitude=round(point.y, 6),
                    method=method,
                    reviewed=bool(override.get("reviewed", False)),
                    review_note=override.get("review_note"),
                ),
                aliases=[],
            )
        )
    return places


def place_index_document(places: list[Place], version: str) -> dict:
    return {
        "schema_version": 1,
        "geography_version": version,
        "source": "Mapping LA via la-geography",
        "place_count": len(places),
        "places": [asdict(place) for place in places],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="re-download the geography")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    paths = download_geography(force=args.refresh)
    frame = load_places(paths[FULL_NAME])
    report = validate_places(frame)
    print(json.dumps(report, indent=2))
    if report["problems"]:
        raise SystemExit("geography validation failed")

    places = build_place_index(frame)
    reviewed = [p for p in places if p.reference_point.reviewed]
    print(f"\nbuilt {len(places)} places; {len(reviewed)} with reviewed reference points")
    for place in places:
        if place.slug in PROTOTYPE_SLUGS:
            reference = place.reference_point
            print(
                f"  {place.slug:16} {reference.longitude:10.4f} {reference.latitude:8.4f}"
                f"  {reference.method}"
            )


if __name__ == "__main__":
    main()
