// Wiring. One store, one hour, and views that all read from it.
//
// Load order is deliberate: the card, chart, slider and comparison come from the main
// bundle, and the map arrives in a separate chunk afterward. Mapbox GL is most of the
// JavaScript here, and nothing about a temperature should wait on a map library.

import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-700.css';
import './styles.css';

import { createChart } from './chart';
import { createCompare } from './compare';
import { FrameStore, loadBundle, loadCounty, loadOutlines } from './data';
import { escape, exactTimestamp, freshness, weekdayHour } from './format';
import { createHero } from './hero';
import { CellLookup, resolveCoordinate, resolvePlace } from './lookup';
import { createPicker, type Picker } from './picker';
import { createSlider } from './slider';
import {
  comparisonFromUrl,
  placeFromUrl,
  rememberPlace,
  rememberedPlace,
  Store,
  writeUrl,
} from './state';
import type { Bundle, Selection } from './types';
import type { MapView } from './map';

const DEFAULT_PLACE = 'downtown';

declare global {
  interface Window {
    feelslike?: { bundle: Bundle; store: Store; map: MapView | null };
  }
}

async function start(): Promise<void> {
  const hero = document.querySelector('#hero') as HTMLElement;
  hero.innerHTML = '<p class="place-name skeleton-text">Loading the forecast…</p>';

  let bundle: Bundle;
  try {
    bundle = await loadBundle();
  } catch (error) {
    hero.innerHTML = `
      <p class="place-name">Forecast unavailable</p>
      <p class="hero-problem-text">We could not load the current forecast. ${escape(
        String((error as Error).message ?? error),
      )}</p>
      <p class="hero-note">Reloading in a minute or two may be enough.</p>
    `;
    setMapMessage('No map, because there is no forecast to draw.');
    return;
  }

  run(bundle);
}

function run(bundle: Bundle): void {
  const store = new Store();
  const lookup = new CellLookup(bundle.grid);
  const frames = new FrameStore(bundle.base, bundle.manifest);

  const heroView = createHero(document.querySelector('#hero') as HTMLElement, bundle);
  const chartView = createChart(document.querySelector('#chart') as HTMLElement, bundle);
  const sliderView = createSlider(
    document.querySelector('#slider') as HTMLElement,
    bundle.manifest,
    (hour) => store.update({ hour }),
  );
  const compareView = createCompare(
    document.querySelector('#compare') as HTMLElement,
    bundle,
    (comparison) => store.update({ comparison }),
  );

  const picker = createPicker(document.querySelector('#search') as HTMLElement, {
    id: 'place-search',
    label: 'Your place',
    placeholder: 'LA city or neighborhood',
    places: bundle.ordered,
    onSelect: selectPlace,
  });

  function selectPlace(slug: string): void {
    const resolved = resolvePlace(bundle, slug);
    if (resolved.kind === 'unsupported') {
      store.update({ problem: resolved.reason });
      return;
    }
    rememberPlace(slug);
    store.update({
      selection: resolved.selection,
      problem: null,
      comparison: store.current.comparison === slug ? null : store.current.comparison,
    });
  }

  let mapView: MapView | null = null;
  let drawnFrame: GeoJSON.FeatureCollection | null = null;
  let frameToken = 0;

  wireGeolocation(bundle, lookup, store, picker);
  writeNotes(bundle);
  writeStatusChip(bundle);

  let lastSelection = store.current.selection;
  store.subscribe((state) => {
    if (state.selection !== lastSelection) sliderView.stop();
    lastSelection = state.selection;
    writeWordmark(bundle, state.selection);
    heroView.render(state.selection, state.hour);
    chartView.render(state.selection, state.hour, state.comparison);
    compareView.render(state.selection, state.hour, state.comparison);
    sliderView.render(state.hour);
    mapView?.highlight(state.selection, state.comparison);
    writeUrl(state);
    if (state.problem) announce(state.problem);

    const token = ++frameToken;
    void frames
      .frame(state.hour)
      .then((frame) => {
        // A slow hour that resolves after the reader has moved on must not draw over
        // the hour they are actually looking at.
        if (token !== frameToken) return;
        drawnFrame = frame;
        mapView?.showFrame(frame);
      })
      .catch(() => {
        if (token === frameToken) {
          setMapMessage('This hour’s map could not be loaded. The forecast above still applies.');
        }
      });
    frames.prefetch(state.hour);
  });

  const requested = placeFromUrl() ?? rememberedPlace() ?? DEFAULT_PLACE;
  const resolved = resolvePlace(bundle, requested);
  const comparison = comparisonFromUrl();
  if (resolved.kind === 'unsupported') {
    const fallback = resolvePlace(bundle, DEFAULT_PLACE);
    store.update({
      selection: fallback.kind === 'unsupported' ? null : fallback.selection,
      problem: `${resolved.reason} Showing downtown Los Angeles instead.`,
      hour: 0,
      comparison,
    });
  } else {
    store.update({ selection: resolved.selection, hour: 0, comparison, problem: null });
  }

  // Everything above is on screen by now. The map, its library and the place outlines
  // load after it, and any failure here leaves the forecast intact.
  void attachMap(bundle).then((view) => {
    mapView = view;
    // A handle for the console and the smoke harness. Read-only in practice, and the
    // only way to ask the map what it drew rather than trusting that it did.
    window.feelslike = { bundle, store, map: view };
    if (!view) return;
    if (drawnFrame) view.showFrame(drawnFrame);
    view.highlight(store.current.selection, store.current.comparison);
    void loadCounty(bundle)
      .then((county) => view.showCounty(county))
      .catch(() => undefined);
    void loadOutlines(bundle)
      .then((outlines) => view.showOutlines(outlines))
      .catch(() => undefined);
  });
}

/**
 * Start the map, or explain its absence.
 *
 * Returns null when the library cannot load or the browser cannot draw it. The caller
 * treats that as normal, because the card and chart never depended on it.
 */
async function attachMap(bundle: Bundle): Promise<MapView | null> {
  const container = document.querySelector('#map') as HTMLElement | null;
  if (!container) return null;
  try {
    if (!webglAvailable()) throw new Error('this browser cannot draw the map');
    const { createLegend, createMap } = await import('./map');
    const view = createMap(container, bundle);
    createLegend(document.querySelector('#legend') as HTMLElement, bundle);
    container.setAttribute(
      'aria-label',
      'Map of apparent temperature across metropolitan Los Angeles at the selected hour. ' +
        'It pans to a selected place outside this view.',
    );
    window.addEventListener('resize', () => view.resize());
    return view;
  } catch (error) {
    setMapMessage(
      `The map could not start (${escape(
        String((error as Error).message ?? error),
      )}). The forecast and the chart are unaffected.`,
    );
    return null;
  }
}

function webglAvailable(): boolean {
  const canvas = document.createElement('canvas');
  return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
}

function setMapMessage(message: string): void {
  const shell = document.querySelector('#map-shell');
  if (shell) shell.innerHTML = `<p class="map-fallback">${message}</p>`;
}

function wireGeolocation(bundle: Bundle, lookup: CellLookup, store: Store, picker: Picker): void {
  const button = document.querySelector('#locate') as HTMLButtonElement;
  const label = button.textContent ?? 'Use my location';

  if (!('geolocation' in navigator)) {
    button.hidden = true;
    return;
  }

  // Asked for only on this click, and the resulting coordinate never reaches the URL.
  button.addEventListener('click', () => {
    announce('Locating…');
    button.disabled = true;
    button.textContent = 'Locating…';

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        button.disabled = false;
        button.textContent = label;
        const { longitude, latitude } = position.coords;
        const outlines = await loadOutlines(bundle).catch(() => null);
        const resolved = resolveCoordinate(bundle, lookup, longitude, latitude, outlines);
        if (resolved.kind === 'unsupported') {
          announce(resolved.reason);
          return;
        }
        announce('');
        rememberPlace(null);
        // The picker is the one view the store does not drive directly — everything
        // else (hero, map, chart, slider readout) redraws from state, but the search
        // box only changes when someone types in it or commits an option. Without this,
        // pressing the button visibly does nothing where a reader is looking: the box
        // they just used still shows whatever they typed before, or nothing at all.
        picker.setValue(resolved.selection.label);
        store.update({ selection: resolved.selection, problem: null });
      },
      (error) => {
        button.disabled = false;
        button.textContent = label;
        announce(
          error.code === error.PERMISSION_DENIED
            ? 'No problem. Search for your neighborhood instead.'
            : 'Your location was not available. Search for your neighborhood instead.',
        );
      },
      { timeout: 10000, maximumAge: 300000 },
    );
  });
}

function announce(message: string): void {
  const status = document.querySelector('#locate-status');
  if (status) status.textContent = message;
}

/**
 * The masthead names the place on screen — "Downtown LA Feels Like" — rather than
 * carrying a fixed brand name above a page that is about to say the same thing again in
 * the summary panel below it.
 *
 * A standalone city drops the redundant "LA": Culver City and Beverly Hills are not Los
 * Angeles, so "Culver City LA Feels Like" would misname them. Neighborhoods and
 * unincorporated areas keep it, because "Del Rey Feels Like" on its own does not say
 * where Del Rey is.
 */
function writeWordmark(bundle: Bundle, selection: Selection | null): void {
  const wordmark = document.querySelector('#wordmark') as HTMLElement | null;
  if (!wordmark) return;
  const place = selection?.slug ? bundle.places.get(selection.slug) : null;
  const name = selection ? escape(selection.label) : null;
  wordmark.innerHTML =
    name === null
      ? 'LA <strong>Feels Like</strong>'
      : place?.source_type === 'standalone-city'
        ? `${name} <strong>Feels Like</strong>`
        : `${name} LA <strong>Feels Like</strong>`;
}

/**
 * Plain freshness metadata, not a status indicator.
 *
 * A pulsing dot beside a word reads as a live sensor, and nothing on this page is one —
 * see freshness() in format.ts. The visible text is the same sentence used in the
 * footer's fuller note; the title attribute adds the exact timestamp for anyone who
 * wants more precision than "2 hours ago."
 */
function writeStatusChip(bundle: Bundle): void {
  const chip = document.querySelector('#status-chip') as HTMLElement | null;
  if (!chip) return;
  const state = freshness(bundle.manifest);
  const reference = bundle.manifest.forecast_reference_times[0];
  chip.textContent = state.state === 'current' ? 'NWS forecast' : state.message;
  chip.title = reference
    ? `${state.message} Issued ${exactTimestamp(reference)}.`
    : state.message;
  chip.className = `status-chip status-${state.state}`;
}

/** A compact source line, with the fuller method behind a disclosure rather than set as
 * running text — see Priority 8: a footer should not read as a second hero. */
function writeNotes(bundle: Bundle): void {
  const notes = document.querySelector('#notes') as HTMLElement;
  const state = freshness(bundle.manifest);
  const first = bundle.manifest.forecast_times[0];
  const last = bundle.manifest.forecast_times[bundle.manifest.forecast_times.length - 1];

  const coverage = bundle.manifest.complete_24h
    ? `Covers ${escape(weekdayHour(first ?? ''))} through ${escape(weekdayHour(last ?? ''))}.`
    : `Covers ${bundle.manifest.forecast_times.length} hours only: ${escape(
        bundle.manifest.coverage_note,
      )}.`;

  notes.innerHTML = `
    <p class="freshness ${state.state}">${escape(state.message)} ${coverage} Values are a
      forecast for a 2.5 km area, not a live sensor reading.</p>
    <details class="methodology">
      <summary>How this works</summary>
      <p>
        Feels like uses the National Weather Service’s apparent-temperature forecast, which
        combines temperature, humidity and wind. Local shade and sunshine can change how it
        feels. Values come from a 2.5 km forecast grid, so one number covers a wide area
        rather than a single block.
      </p>
      <p class="credit">
        Forecasts from the
        <a href="https://www.weather.gov/documentation/services-web-api">National Weather
        Service</a> National Digital Forecast Database. Place boundaries from
        <a href="https://whatsmyla.com">WhatsMyLA.com</a>. Read <a href="https://github.com/stiles/feelslike.la">more about the data</a>.
      </p>
    </details>
  `;
}

void start();
