"""Download NDFD GRIB2 grids and record what was retrieved.

Every download writes a sidecar record with the URL, HTTP metadata, byte count,
retrieval time and SHA-256 digest so a build can be reproduced or audited later.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import requests

from .config import RAW_DIR, USER_AGENT, ForecastConfig, load_forecast_config

log = logging.getLogger(__name__)

CHUNK_BYTES = 1 << 20


@dataclass
class SourceFile:
    element: str
    url: str
    path: str
    bytes: int
    sha256: str
    retrieved_at: str
    last_modified: str | None
    etag: str | None


def build_id(now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    return now.strftime("%Y%m%dT%H%M%SZ")


def download(url: str, destination: Path, *, timeout: float, max_attempts: int, backoff: float) -> SourceFile:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    last_error: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            started = datetime.now(UTC)
            digest = hashlib.sha256()
            size = 0
            with requests.get(
                url,
                stream=True,
                timeout=timeout,
                headers={"User-Agent": USER_AGENT},
            ) as response:
                response.raise_for_status()
                with temporary.open("wb") as fh:
                    for chunk in response.iter_content(CHUNK_BYTES):
                        fh.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                headers = response.headers
            temporary.replace(destination)
            log.info("downloaded %s (%.1f MB) in %.1fs", url, size / 1e6,
                     (datetime.now(UTC) - started).total_seconds())
            return SourceFile(
                element="",
                url=url,
                path=str(destination),
                bytes=size,
                sha256=digest.hexdigest(),
                retrieved_at=started.isoformat().replace("+00:00", "Z"),
                last_modified=headers.get("Last-Modified"),
                etag=headers.get("ETag"),
            )
        except (requests.RequestException, OSError) as error:
            last_error = error
            temporary.unlink(missing_ok=True)
            if attempt == max_attempts:
                break
            delay = backoff * (2 ** (attempt - 1))
            log.warning("attempt %d/%d failed for %s: %s; retrying in %.1fs",
                        attempt, max_attempts, url, error, delay)
            time.sleep(delay)

    raise RuntimeError(f"could not download {url} after {max_attempts} attempts") from last_error


def fetch_all(config: ForecastConfig | None = None, *, destination: Path | None = None) -> dict:
    config = config or load_forecast_config()
    identifier = build_id()
    destination = destination or RAW_DIR / identifier
    options = config.download

    files: list[SourceFile] = []
    for element, filename in config.elements.items():
        url = config.element_url(element)
        record = download(
            url,
            destination / filename,
            timeout=options["timeout_seconds"],
            max_attempts=options["max_attempts"],
            backoff=options["backoff_seconds"],
        )
        record.element = element
        files.append(record)

    manifest = {
        "build_id": identifier,
        "provider": config.source["provider"],
        "sector": config.source["sector"],
        "period": config.source["period"],
        "source_files": [asdict(f) for f in files],
    }
    record_path = destination / "download.json"
    record_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("wrote %s", record_path)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    manifest = fetch_all(destination=args.destination)
    for record in manifest["source_files"]:
        print(f"{record['element']:>22}  {record['bytes'] / 1e6:7.1f} MB  {record['path']}")


if __name__ == "__main__":
    main()
