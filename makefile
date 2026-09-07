.PHONY: all install setup build publish replay fixture prototype test lint clean \
	web-install web-build web-test web-smoke web-fixture web

# `all` chains install, setup and build, and deliberately excludes clean so the
# published assets survive for an upload step.
all: install setup build

install:
	uv sync

setup:
	mkdir -p data build

# One build from current sources: download, decode, export, validate, publish (locally
# — "publish" here means writing under build/, not uploading anywhere).
build:
	uv run python -m feelslike_la.pipeline

# Upload the build latest.json points at to S3, for the deployed web app to read.
# Needs MY_AWS_ACCESS_KEY_ID, MY_AWS_SECRET_ACCESS_KEY, MY_DEFAULT_REGION in the
# environment; see .github/workflows/update-forecast.yml for where those come from in CI.
publish:
	uv run --extra publish python scripts/publish_to_s3.py

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

# The interface. `web` is the full check: types, unit tests, bundle, browser.
web: web-build web-test web-smoke

web-install:
	cd web && npm install

web-build:
	cd web && npx tsc --noEmit && npx vite build

web-test:
	cd web && npx vitest run

# Drives the built bundle in the installed Chrome against the published build.
# Add SHOTS=1 to write screenshots to build/screenshots.
web-smoke:
	cd web && node scripts/smoke.mjs $(if $(SHOTS),--shots,)

# Regenerate the browser lookup's expected cell ids from the Python resolver. Run this
# after any change to the grid, the crop window or the published lookup formula.
web-fixture:
	uv run python scripts/web_lookup_fixture.py

# Removes generated builds only. Raw downloads and geography stay put.
clean:
	rm -rf build/builds build/failed build/latest.json build/prototype build/screenshots
	rm -rf web/dist
