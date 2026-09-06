"""Publication must never trade a good build for a broken one."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar

import pytest

from feelslike_la import pipeline


@pytest.fixture
def publish_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "build"
    monkeypatch.setattr(pipeline, "BUILD_DIR", root)
    monkeypatch.setattr(pipeline, "BUILDS_DIR", root / "builds")
    monkeypatch.setattr(pipeline, "FAILED_DIR", root / "failed")
    monkeypatch.setattr(pipeline, "LATEST_POINTER", root / "latest.json")
    return root


def staged(root: Path, build_id: str) -> Path:
    directory = root / f"{build_id}.staging"
    directory.mkdir(parents=True)
    (directory / "manifest.json").write_text(json.dumps({"build_id": build_id}))
    return directory


def test_publishing_moves_the_build_and_repoints_latest(publish_root: Path):
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z")

    pointer = json.loads((publish_root / "latest.json").read_text())
    assert pointer["build_id"] == "20260906T200000Z"
    assert pointer["previous_build_id"] is None
    assert (publish_root / "builds" / "20260906T200000Z" / "manifest.json").exists()
    assert not (publish_root / "20260906T200000Z.staging").exists()


def test_a_second_publish_records_the_build_it_replaced(publish_root: Path):
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z")
    pipeline.publish(staged(publish_root, "20260906T210000Z"), "20260906T210000Z")

    pointer = json.loads((publish_root / "latest.json").read_text())
    assert pointer["build_id"] == "20260906T210000Z"
    assert pointer["previous_build_id"] == "20260906T200000Z"
    # The replaced build is still on disk and still readable.
    assert (publish_root / "builds" / "20260906T200000Z" / "manifest.json").exists()


def test_an_older_build_does_not_take_over_the_pointer(publish_root: Path):
    """Replaying an old fixture must not roll the live forecast backwards."""
    pipeline.publish(staged(publish_root, "20260906T210000Z"), "20260906T210000Z")
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z")

    pointer = json.loads((publish_root / "latest.json").read_text())
    assert pointer["build_id"] == "20260906T210000Z"
    # The older build is still written out, just not published.
    assert (publish_root / "builds" / "20260906T200000Z" / "manifest.json").exists()


def test_an_older_build_can_be_published_deliberately(publish_root: Path):
    pipeline.publish(staged(publish_root, "20260906T210000Z"), "20260906T210000Z")
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z", force=True)

    pointer = json.loads((publish_root / "latest.json").read_text())
    assert pointer["build_id"] == "20260906T200000Z"


def test_prune_never_removes_the_published_build(publish_root: Path):
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z")

    old = publish_root / "builds" / "20250101T000000Z"
    old.mkdir(parents=True)
    (old / "manifest.json").write_text("{}")

    removed = pipeline.prune(retain_days=7)
    assert removed == ["20250101T000000Z"]
    assert (publish_root / "builds" / "20260906T200000Z").exists()


def test_prune_keeps_builds_inside_the_retention_window(publish_root: Path):
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z")
    recent = (datetime.now(UTC) - timedelta(days=2)).strftime("%Y%m%dT%H%M%SZ")
    (publish_root / "builds" / recent).mkdir(parents=True)

    assert pipeline.prune(retain_days=7) == []
    assert (publish_root / "builds" / recent).exists()


def test_prune_ignores_directories_that_are_not_builds(publish_root: Path):
    (publish_root / "builds" / "scratch").mkdir(parents=True)
    assert pipeline.prune(retain_days=1) == []
    assert (publish_root / "builds" / "scratch").exists()


def test_a_failed_build_leaves_the_pointer_alone(publish_root: Path, monkeypatch):
    """The whole point: a broken build must not become the published one."""
    pipeline.publish(staged(publish_root, "20260906T200000Z"), "20260906T200000Z")
    before = (publish_root / "latest.json").read_text()

    monkeypatch.setattr(pipeline, "load_forecast_config", lambda: _config())
    monkeypatch.setattr(pipeline, "prepare_from_fixture", lambda *a, **k: _prepared())
    monkeypatch.setattr(pipeline, "assemble", _broken_assemble)

    with pytest.raises(pipeline.ValidationFailed) as failure:
        pipeline.run(fixture=Path("ignored.npz"))

    assert "manifest.json is missing" in str(failure.value)
    assert (publish_root / "latest.json").read_text() == before
    assert (publish_root / "builds" / "20260906T200000Z" / "manifest.json").exists()
    # The failed attempt is kept for debugging, outside the published tree.
    assert (publish_root / "failed" / "20260906T220000Z").exists()
    assert not (publish_root / "builds" / "20260906T220000Z").exists()


def _broken_assemble(prepared, config, destination: Path) -> dict:
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "places.json").write_text("{}")
    return {"build_id": prepared.build_id}


class _Config:
    forecast: ClassVar[dict] = {"horizon_hours": 24}


def _config():
    return _Config()


def _prepared():
    class Prepared:
        build_id = "20260906T220000Z"

    return Prepared()
