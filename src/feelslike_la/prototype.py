"""Milestone 1: prove the data.

Takes a downloaded NDFD build and produces a six-place time series, a raw-cell map,
a contoured map and a machine-readable findings summary. Nothing here is published,
and nothing is smoothed, filled or interpolated in a way that invents detail.
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import math
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from affine import Affine
from shapely.geometry import Point

from . import geography as geo
from .config import BUILD_DIR, RAW_DIR, load_forecast_config
from .contours import build_bands, display_mask, vertex_count, write_frame
from .grid import Inventory, coverage_window, inventory, read_frames_f
from .sample import CellReference, CellResolver, series_at
from .times import iso_z, local_label, select_hourly_window, utc_key

log = logging.getLogger(__name__)

OUTPUT_DIR = BUILD_DIR / "prototype"
PLACE_COLORS = {
    "santa-monica": "#5194C3",
    "del-rey": "#53A796",
    "downtown": "#7C4EA5",
    "pasadena": "#F18851",
    "woodland-hills": "#F8C153",
    "lancaster": "#C52622",
}


def haversine_miles(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 3958.7613
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def county_cell_mask(reference: dict, boundary: gpd.GeoDataFrame) -> np.ndarray:
    """True where a native cell's center falls inside the county."""
    from rasterio.features import geometry_mask

    shapes = boundary.to_crs(reference["crs"]).geometry
    return ~geometry_mask(
        shapes,
        out_shape=(reference["height"], reference["width"]),
        transform=reference["transform"],
        all_touched=False,
        invert=False,
    )


def class_counts(values: np.ndarray, interval: float) -> int:
    """How many fixed-width classes of `interval` degrees the finite values occupy."""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return 0
    return int(np.unique(np.floor(finite / interval)).size)


def latest_raw_build(root: Path = RAW_DIR) -> Path:
    candidates = sorted(p for p in root.glob("*/download.json"))
    if not candidates:
        raise SystemExit("no downloads found; run `python -m feelslike_la.fetch` first")
    return candidates[-1].parent


def check_aligned(first: Inventory, second: Inventory) -> None:
    if first.grid_fingerprint() != second.grid_fingerprint():
        raise ValueError("the two elements do not share a grid geometry")
    if first.valid_times != second.valid_times:
        raise ValueError("the two elements do not share valid times")


def build_series_table(
    places: list[geo.Place],
    resolver: CellResolver,
    apparent: np.ndarray,
    air: np.ndarray,
    times: list[datetime],
) -> tuple[pd.DataFrame, dict[str, CellReference]]:
    rows = []
    cells: dict[str, CellReference] = {}
    for place in places:
        point = place.reference_point
        cell = resolver.resolve(point.longitude, point.latitude)
        cells[place.slug] = cell
        apparent_series = series_at(apparent, cell)
        air_series = series_at(air, cell)
        for index, moment in enumerate(times):
            rows.append(
                {
                    "slug": place.slug,
                    "name": place.name,
                    "cell_id": cell.cell_id,
                    "valid_time": iso_z(moment),
                    "local_label": local_label(moment),
                    "apparent_temperature_f": float(apparent_series[index]),
                    "temperature_f": float(air_series[index]),
                }
            )
    return pd.DataFrame(rows), cells


def plot_series(frame: pd.DataFrame, times: list[datetime], reference: datetime, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    from .times import LOS_ANGELES

    plt.rcParams.update(
        {
            "font.family": ["Roboto", "Helvetica Neue", "DejaVu Sans"],
            "font.size": 11,
            "text.color": "#262626",
            "axes.edgecolor": "#B1B1B1",
            "axes.linewidth": 0.5,
            "figure.facecolor": "#FEFEFE",
            "axes.facecolor": "#FEFEFE",
            "xtick.color": "#A6A6A6",
            "ytick.color": "#A6A6A6",
            "grid.color": "#ececec",
            "grid.linewidth": 0.6,
        }
    )

    local_times = [t.astimezone(LOS_ANGELES) for t in times]
    figure, axes = plt.subplots(figsize=(9.6, 5.4))
    axes.grid(axis="y")
    axes.set_axisbelow(True)
    for spine in ("top", "right", "left"):
        axes.spines[spine].set_visible(False)

    labels = []
    for slug, group in frame.groupby("slug", sort=False):
        group = group.reset_index(drop=True)
        color = PLACE_COLORS.get(slug, "#8e8e8e")
        values = group["apparent_temperature_f"].to_numpy()
        axes.plot(local_times, values, color=color, linewidth=2)
        peak = int(np.nanargmax(values))
        axes.plot(local_times[peak], values[peak], "o", color=color, markersize=5,
                  markeredgecolor="#FEFEFE", markeredgewidth=1.4)
        labels.append((values[-1], f"{group['name'][0]}  {values[-1]:.0f}°", color))

    # Push overlapping end labels apart, leaving the lines on their true values.
    labels.sort()
    span = max(v for v, _, _ in labels) - min(v for v, _, _ in labels)
    minimum_gap = max(1.6, span * 0.07)
    positions = []
    for value, _, _ in labels:
        if positions and value - positions[-1] < minimum_gap:
            positions.append(positions[-1] + minimum_gap)
        else:
            positions.append(value)
    for (_, text, color), position in zip(labels, positions, strict=True):
        axes.annotate(
            text,
            xy=(local_times[-1], position),
            xytext=(8, 0),
            textcoords="offset points",
            color=color,
            fontsize=11,
            fontweight="bold",
            va="center",
        )

    axes.xaxis.set_major_formatter(mdates.DateFormatter("%-I %p", tz=LOS_ANGELES))
    axes.xaxis.set_major_locator(mdates.HourLocator(byhour=range(0, 24, 6), tz=LOS_ANGELES))
    axes.set_xlim(local_times[0], local_times[-1])
    axes.margins(x=0.22)
    ticks = axes.get_yticks()
    axes.set_yticks(ticks)
    axes.set_yticklabels(
        [f"{value:.0f}°" if value == ticks[-1] else f"{value:.0f}" for value in ticks]
    )
    axes.set_ylim(bottom=min(frame["apparent_temperature_f"]) - 2)
    axes.set_title(
        f"Forecast apparent temperature, {local_label(times[0])} to {local_label(times[-1])}\n"
        f"Dots mark each place's peak within the window. "
        f"NDFD run issued {local_label(reference, with_minutes=True)}.",
        loc="left",
        fontsize=13,
        color="#262626",
    )
    figure.text(
        0.01,
        0.015,
        "Source: NOAA/NWS National Digital Forecast Database, 2.5 km CONUS grid. "
        "Places from Mapping LA via la-geography.",
        fontsize=9,
        color="#8e8e8e",
    )
    figure.tight_layout(rect=(0, 0.04, 1, 1))
    figure.savefig(path, dpi=150)
    plt.close(figure)


def band_palette(breaks: list[float]):
    """One color per class, including the open bottom and top classes."""
    import matplotlib.pyplot as plt

    palette = plt.get_cmap("YlOrRd")
    return [palette(value) for value in np.linspace(0.04, 0.96, len(breaks) + 1)]


def plot_maps(
    field: np.ndarray,
    reference: dict,
    bands: gpd.GeoDataFrame,
    places: list[geo.Place],
    valid_time: datetime,
    breaks: list[float],
    boundary: gpd.GeoDataFrame,
    raw_path: Path,
    band_path: Path,
) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    from rasterio.plot import plotting_extent

    colors = band_palette(breaks)
    colormap = ListedColormap(colors)
    colormap.set_bad("#e5e5e4")
    norm = BoundaryNorm(breaks, colormap.N, extend="both")

    boundary_native = boundary.to_crs(reference["crs"])
    label = local_label(valid_time)

    figure, axes = plt.subplots(figsize=(8, 8))
    axes.imshow(
        np.ma.masked_invalid(field),
        extent=plotting_extent(field, reference["transform"]),
        cmap=colormap,
        norm=norm,
        interpolation="nearest",
    )
    boundary_native.boundary.plot(ax=axes, color="#262626", linewidth=0.7)
    axes.set_title(f"Native 2.5 km cells, apparent temperature\n{label}", loc="left", fontsize=12)
    axes.set_axis_off()
    figure.tight_layout()
    figure.savefig(raw_path, dpi=150)
    plt.close(figure)

    figure, axes = plt.subplots(figsize=(8, 8))
    bands_native = bands.to_crs(reference["crs"])
    for band_id, group in bands_native.groupby("band_id"):
        group.plot(ax=axes, color=colors[int(band_id)], linewidth=0)
    boundary_native.boundary.plot(ax=axes, color="#262626", linewidth=0.7)

    markers = gpd.GeoSeries(
        [Point(p.reference_point.longitude, p.reference_point.latitude) for p in places],
        crs="EPSG:4326",
    ).to_crs(reference["crs"])
    for place, marker in zip(places, markers, strict=True):
        axes.plot(marker.x, marker.y, "o", color="#262626", markersize=3)
        axes.annotate(
            place.name,
            (marker.x, marker.y),
            xytext=(5, 4),
            textcoords="offset points",
            fontsize=9,
            color="#262626",
        )
    axes.set_title(
        f"Filled contours from the same field, 5°F classes\n{label}", loc="left", fontsize=12
    )
    axes.set_axis_off()
    figure.tight_layout()
    figure.savefig(band_path, dpi=150)
    plt.close(figure)


def run(build: Path | None = None, api_check: bool = True) -> dict:
    config = load_forecast_config()
    build = build or latest_raw_build()
    download = json.loads((build / "download.json").read_text())
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    paths = {record["element"]: Path(record["path"]) for record in download["source_files"]}
    apparent_inventory = inventory(paths["apparent_temperature"])
    air_inventory = inventory(paths["temperature"])
    check_aligned(apparent_inventory, air_inventory)

    window = select_hourly_window(
        apparent_inventory.valid_times, hours=config.forecast["horizon_hours"]
    )
    log.info("time window: %s", window.note)
    if not window.times:
        raise SystemExit("no usable forecast hours in this build")

    bands_apparent = [apparent_inventory.band_for(t) for t in window.times]
    bands_air = [air_inventory.band_for(t) for t in window.times]
    units = sorted({b.unit_name for b in bands_apparent + bands_air})

    crop = coverage_window(paths["apparent_temperature"], config.coverage)
    apparent, reference = read_frames_f(paths["apparent_temperature"], bands_apparent, crop)
    air, _ = read_frames_f(paths["temperature"], bands_air, crop)
    log.info("cropped field: %s cells per frame", apparent.shape[1:])

    geo.download_geography()
    frame = geo.load_places()
    validation = geo.validate_places(frame)
    if validation["problems"]:
        raise SystemExit(f"geography validation failed: {validation['problems']}")
    index = {place.slug: place for place in geo.build_place_index(frame)}
    places = [index[slug] for slug in geo.PROTOTYPE_SLUGS]

    resolver = CellResolver(
        reference["crs"],
        Affine(*apparent_inventory.transform),
        apparent_inventory.width,
        apparent_inventory.height,
        window=crop,
    )
    series, cells = build_series_table(places, resolver, apparent, air, window.times)
    series.to_csv(OUTPUT_DIR / "six_place_series.csv", index=False)

    peak_row = series.loc[series["apparent_temperature_f"].idxmax()]
    peak_time = datetime.fromisoformat(peak_row["valid_time"])
    peak_index = window.times.index(peak_time)

    plot_series(series, window.times, apparent_inventory.reference_times[0],
                OUTPUT_DIR / "six_place_series.png")

    boundary = geo.load_boundary()
    mask = display_mask(boundary, config.display["clip_simplify_degrees"])
    field = apparent[peak_index]
    contour_bands = build_bands(field, reference, config.band_breaks_f, clip=mask)
    frame_path = OUTPUT_DIR / f"frame_{utc_key(peak_time)}.geojson"
    frame_bytes = write_frame(contour_bands, frame_path, config.display["coordinate_precision"])
    frame_gzip_bytes = len(gzip.compress(frame_path.read_bytes()))

    unmasked = build_bands(field, reference, config.band_breaks_f, clip=boundary)
    unmasked_path = OUTPUT_DIR / f"frame_{utc_key(peak_time)}_full_coastline.geojson"
    unmasked_bytes = write_frame(unmasked, unmasked_path, 12)

    plot_maps(
        field,
        reference,
        contour_bands,
        places,
        peak_time,
        config.band_breaks_f,
        boundary,
        OUTPUT_DIR / "map_native_cells.png",
        OUTPUT_DIR / "map_contours.png",
    )

    # Do the raw cells and the contours agree where a place sits?
    agreement = []
    for place in places:
        cell = cells[place.slug]
        point = Point(place.reference_point.longitude, place.reference_point.latitude)
        hit = contour_bands[contour_bands.geometry.covers(point)]
        cell_value = float(field[cell.window_row, cell.window_col])
        band = None if hit.empty else hit.iloc[0]
        agreement.append(
            {
                "slug": place.slug,
                "cell_value_f": round(cell_value, 2),
                "band_id": None if band is None else int(band["band_id"]),
                "band_lower_f": None if band is None else band["lower_f"],
                "band_upper_f": None if band is None else band["upper_f"],
                "cell_value_inside_band": None
                if band is None
                else bool(
                    (band["lower_f"] is None or cell_value >= band["lower_f"])
                    and (band["upper_f"] is None or cell_value < band["upper_f"])
                ),
            }
        )

    api_results = []
    if api_check:
        from .nws_api import gridpoint

        for place in places:
            point = place.reference_point
            cell = cells[place.slug]
            try:
                payload = gridpoint(point.longitude, point.latitude)
            except Exception as error:  # noqa: BLE001 - a spot check must not fail the run
                api_results.append({"slug": place.slug, "error": str(error)})
                continue
            comparisons = []
            for index_position, moment in enumerate(window.times[:6]):
                api_value = payload["apparentTemperature"].get(moment)
                grid_value = float(apparent[index_position, cell.window_row, cell.window_col])
                comparisons.append(
                    {
                        "valid_time": iso_z(moment),
                        "grib_f": round(grid_value, 2),
                        "api_f": None if api_value is None else round(api_value, 2),
                        "difference_f": None
                        if api_value is None
                        else round(grid_value - api_value, 2),
                    }
                )
            api_results.append(
                {
                    "slug": place.slug,
                    "grid_id": payload["grid_id"],
                    "grid_x": payload["grid_x"],
                    "grid_y": payload["grid_y"],
                    "api_update_time": payload["update_time"],
                    "comparisons": comparisons,
                }
            )

    # Does the county have enough spread at a given hour to justify 5-degree classes?
    inside_county = county_cell_mask(reference, boundary)
    county_spread = []
    for index_position, moment in enumerate(window.times):
        cells_in_county = np.where(inside_county, apparent[index_position], np.nan)
        county_spread.append(
            {
                "valid_time": iso_z(moment),
                "local_label": local_label(moment),
                "county_cells": int(np.isfinite(cells_in_county).sum()),
                "minimum_f": round(float(np.nanmin(cells_in_county)), 2),
                "maximum_f": round(float(np.nanmax(cells_in_county)), 2),
                "spread_f": round(
                    float(np.nanmax(cells_in_county) - np.nanmin(cells_in_county)), 2
                ),
                "classes_at_5f": class_counts(cells_in_county, 5.0),
                "classes_at_2f": class_counts(cells_in_county, 2.0),
            }
        )

    summary = series.groupby(["slug", "name"], sort=False).agg(
        minimum_f=("apparent_temperature_f", "min"),
        maximum_f=("apparent_temperature_f", "max"),
        mean_air_f=("temperature_f", "mean"),
    )
    summary["range_f"] = summary["maximum_f"] - summary["minimum_f"]
    difference = series["apparent_temperature_f"] - series["temperature_f"]

    findings = {
        "generated_at": iso_z(datetime.now(UTC)),
        "build_id": download["build_id"],
        "source": {
            "provider": download["provider"],
            "sector": download["sector"],
            "period": download["period"],
            "files": [
                {
                    "element": record["element"],
                    "url": record["url"],
                    "bytes": record["bytes"],
                    "sha256": record["sha256"],
                    "retrieved_at": record["retrieved_at"],
                    "last_modified": record["last_modified"],
                }
                for record in download["source_files"]
            ],
        },
        "grid": {
            "fingerprint": apparent_inventory.grid_fingerprint(),
            "width": apparent_inventory.width,
            "height": apparent_inventory.height,
            "pixel_size_m": [
                abs(apparent_inventory.transform[0]),
                abs(apparent_inventory.transform[4]),
            ],
            "declared_units": units,
            "band_count": len(apparent_inventory.bands),
            "reference_times": [iso_z(t) for t in apparent_inventory.reference_times],
            "cropped_shape": list(apparent.shape),
            "nodata_cells_first_frame": int(np.isnan(apparent[0]).sum()),
            "finite_cells_first_frame": int(np.isfinite(apparent[0]).sum()),
        },
        "time_window": {
            "requested_hours": window.requested_hours,
            "complete": window.complete,
            "note": window.note,
            "first_valid_time": iso_z(window.first),
            "last_valid_time": iso_z(window.last),
            "first_local_label": local_label(window.first),
            "source_age_at_download_minutes": round(
                (
                    datetime.fromisoformat(
                        download["source_files"][0]["retrieved_at"]
                    )
                    - apparent_inventory.reference_times[0]
                ).total_seconds()
                / 60
            ),
        },
        "geography": {
            "place_count": validation["count"],
            "duplicate_slugs": validation["duplicate_slugs"],
            "invalid_geometries": validation["invalid_geometries"],
            "bounds": validation["bounds"],
            "types": validation["types"],
        },
        "places": {
            slug: {
                **asdict(cell),
                "reference_longitude": index[slug].reference_point.longitude,
                "reference_latitude": index[slug].reference_point.latitude,
                "reference_method": index[slug].reference_point.method,
                "reviewed": index[slug].reference_point.reviewed,
                "distance_to_cell_center_mi": round(
                    haversine_miles(
                        index[slug].reference_point.longitude,
                        index[slug].reference_point.latitude,
                        cell.center_longitude,
                        cell.center_latitude,
                    ),
                    2,
                ),
            }
            for slug, cell in cells.items()
        },
        "distinct_cells": len({cell.cell_id for cell in cells.values()}),
        "series_summary": json.loads(summary.round(2).reset_index().to_json(orient="records")),
        "spread_at_peak_hour_f": {
            "valid_time": iso_z(peak_time),
            "local_label": local_label(peak_time),
            "warmest": peak_row["name"],
            "warmest_f": round(float(peak_row["apparent_temperature_f"]), 2),
            "coolest_f": round(
                float(series[series["valid_time"] == peak_row["valid_time"]][
                    "apparent_temperature_f"
                ].min()),
                2,
            ),
        },
        "apparent_minus_air_f": {
            "minimum": round(float(difference.min()), 2),
            "maximum": round(float(difference.max()), 2),
            "share_within_half_degree": round(float((difference.abs() <= 0.5).mean()), 3),
        },
        "county_spread_by_hour": county_spread,
        "contours": {
            "valid_time": iso_z(peak_time),
            "band_breaks_f": config.band_breaks_f,
            "feature_count": len(contour_bands),
            "band_ids": sorted(int(v) for v in contour_bands["band_id"].unique()),
            "field_min_f": round(float(np.nanmin(field)), 2),
            "field_max_f": round(float(np.nanmax(field)), 2),
            "simplified_mask_bytes": frame_bytes,
            "simplified_mask_gzip_bytes": frame_gzip_bytes,
            "simplified_mask_vertices": vertex_count(contour_bands),
            "full_coastline_bytes": unmasked_bytes,
            "full_coastline_vertices": vertex_count(unmasked),
            "place_agreement": agreement,
        },
        "api_spot_check": api_results,
    }

    findings_path = OUTPUT_DIR / "findings.json"
    findings_path.write_text(json.dumps(findings, indent=2) + "\n")
    log.info("wrote %s", findings_path)
    return findings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, default=None)
    parser.add_argument("--skip-api", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    findings = run(build=args.build, api_check=not args.skip_api)
    print(json.dumps(findings["time_window"], indent=2))
    print(json.dumps(findings["series_summary"], indent=2))


if __name__ == "__main__":
    main()
