.PHONY: all install setup build replay fixture prototype test lint clean

# `all` chains install, setup and build, and deliberately excludes clean so the
# published assets survive for an upload step.
all: install setup build

install:
	uv sync

setup:
	mkdir -p data build

# One build from current sources: download, decode, export, validate, publish.
build:
	uv run python -m feelslike_la.pipeline

# The same build from a saved fixture, with no network calls to NOAA.
replay:
	uv run python -m feelslike_la.pipeline --from-fixture data/fixtures/build.npz

# Refresh the committed replay fixture from current sources.
fixture:
	uv run python -m feelslike_la.pipeline --save-fixture data/fixtures/build.npz

# Milestone 1 charts, maps and findings.
prototype:
	uv run python -m feelslike_la.prototype

test:
	uv run pytest -q

lint:
	uv run ruff check .

# Removes generated builds only. Raw downloads and geography stay put.
clean:
	rm -rf build/builds build/failed build/latest.json build/prototype
