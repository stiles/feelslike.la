#!/usr/bin/env python3
"""Publish one build/ to S3, for the web app to read via VITE_DATA_BASE.

    uv run python scripts/publish_to_s3.py

Uploads exactly two things, in this order:
  1. The build directory build/builds/<build_id>/, immutable and cached hard, so once a
     build_id is live it never needs re-fetching.
  2. build/latest.json, the pointer, cached for a minute at most, since it is the one
     file every session re-checks to learn a newer build exists.

That order matters: a reader who fetches the new pointer before the build behind it has
finished uploading gets 404s. Uploading the immutable directory first, and the mutable
pointer last, is what keeps every published pointer honest.

Mirrors the pattern in davis.food/scripts/upload_to_s3.py: same bucket, same
MY_AWS_*-prefixed environment variables (the MY_ prefix dodges the AWS_* names the
`aws-actions/configure-aws-credentials` action and the AWS CLI itself already claim).
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

BUCKET = "stilesdata.com"
PREFIX = "feelslike.la/"

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
LATEST_POINTER = BUILD_DIR / "latest.json"

IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
POINTER_CACHE = "public, max-age=60, must-revalidate"


def s3_client():
    access_key = os.environ.get("MY_AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("MY_AWS_SECRET_ACCESS_KEY")
    region = os.environ.get("MY_DEFAULT_REGION", "us-east-1")
    if not access_key or not secret_key:
        raise SystemExit(
            "MY_AWS_ACCESS_KEY_ID and MY_AWS_SECRET_ACCESS_KEY must be set "
            "(as GitHub Actions secrets in CI, or in your own shell locally)."
        )
    return boto3.client(
        "s3",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
    )


def content_type(path: Path) -> str:
    if path.suffix == ".geojson":
        return "application/json"
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def upload_tree(client, local_dir: Path, key_prefix: str, cache_control: str) -> int:
    count = 0
    for path in sorted(local_dir.rglob("*")):
        if not path.is_file():
            continue
        key = f"{key_prefix}{path.relative_to(local_dir).as_posix()}"
        try:
            client.upload_file(
                str(path),
                BUCKET,
                key,
                ExtraArgs={"ContentType": content_type(path), "CacheControl": cache_control},
            )
        except ClientError as error:
            raise SystemExit(f"failed to upload {path} to s3://{BUCKET}/{key}: {error}") from error
        count += 1
    return count


def main() -> int:
    if not LATEST_POINTER.exists():
        raise SystemExit(f"{LATEST_POINTER} does not exist; run `make build` first")

    pointer = json.loads(LATEST_POINTER.read_text())
    build_id = pointer["build_id"]
    build_dir = BUILD_DIR / "builds" / build_id
    if not build_dir.exists():
        raise SystemExit(f"{build_dir} does not exist; latest.json points at a build not on disk")

    client = s3_client()

    build_count = upload_tree(client, build_dir, f"{PREFIX}builds/{build_id}/", IMMUTABLE_CACHE)
    print(f"uploaded {build_count} files from {build_dir} to s3://{BUCKET}/{PREFIX}builds/{build_id}/")

    client.upload_file(
        str(LATEST_POINTER),
        BUCKET,
        f"{PREFIX}latest.json",
        ExtraArgs={"ContentType": "application/json", "CacheControl": POINTER_CACHE},
    )
    print(f"published pointer: https://{BUCKET}/{PREFIX}latest.json -> {build_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
