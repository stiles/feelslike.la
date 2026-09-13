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

  // "Pick a city or LA neighborhood" spelled out what the placeholder already shows by
  // example — one city, one neighborhood — in a caption meant to be read at a glance.
  const picker = createPicker(document.querySelector('#search') as HTMLElement, {
    id: 'place-search',
    label: 'Find a place',
    placeholder: 'Santa Monica, Venice...',
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

  /**
   * Changing place from anywhere but the search box itself — the map, the masthead.
   *
   * The search box is the one view the store does not drive: everything else (hero, map,
   * chart, slider readout) redraws from state, but the box only changes when someone
   * types in it or commits an option. Without this it goes on naming the place the
   * reader just moved away from.
   */
  function selectFromElsewhere(slug: string): void {
    selectPlace(slug);
    const name = bundle.places.get(slug)?.name;
    if (name) picker.setValue(name);
  }

  let mapView: MapView | null = null;
  let drawnFrame: GeoJSON.FeatureCollection | null = null;
  let frameToken = 0;

  wireGeolocation(bundle, lookup, store, picker);
  wireNavPlace(bundle, store, selectFromElsewhere);
  writeNotes(bundle);
  writeStatusChip(bundle);

  let lastSelection = store.current.selection;
  store.subscribe((state) => {
    if (state.selection !== lastSelection) sliderView.stop();
    lastSelection = state.selection;
    writeWordmark(bundle, state.selection);
    writeTitle(bundle, state.selection);
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
  void attachMap(bundle, selectFromElsewhere).then((view) => {
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
async function attachMap(
  bundle: Bundle,
  onSelect: (slug: string) => void,
): Promise<MapView | null> {
  const container = document.querySelector('#map') as HTMLElement | null;
  if (!container) return null;
  try {
    if (!webglAvailable()) throw new Error('this browser cannot draw the map');
    const { createLegend, createMap } = await import('./map');
    const view = createMap(container, bundle, onSelect);
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
  // The icon beside this label is permanent — swap the label span's text only, so
  // "Locating…" never wipes out the icon the way overwriting the button's own
  // textContent would.
  const labelEl = button.querySelector('.locate-label') as HTMLElement;
  const label = labelEl.textContent ?? 'My location';

  if (!('geolocation' in navigator)) {
    button.hidden = true;
    return;
  }

  // Asked for only on this click, and the resulting coordinate never reaches the URL.
  button.addEventListener('click', () => {
    announce('Locating…');
    button.disabled = true;
    labelEl.textContent = 'Locating…';

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        button.disabled = false;
        labelEl.textContent = label;
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
        labelEl.textContent = label;
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
 * The masthead's place control, which exists only while the summary panel's search box
 * is off screen.
 *
 * An earlier version of this lived here unconditionally and was a plain duplicate: the
 * masthead did not stick, so the real search box was always within a screen of it, and
 * opening the masthead's copy covered the box it was copying. What changed is that the
 * masthead sticks now, so there is a long stretch of page — the chart, the map, the
 * comparison table — where the search box is genuinely gone and the only way to change
 * place is to scroll back up and lose your spot. An IntersectionObserver watches the
 * search row and reveals the button exactly for that stretch. Two pickers are never
 * reachable at once.
 */
function wireNavPlace(bundle: Bundle, store: Store, onSelect: (slug: string) => void): void {
  const masthead = document.querySelector('.masthead') as HTMLElement;
  const button = document.querySelector('#nav-place') as HTMLButtonElement;
  const chip = document.querySelector('#status-chip') as HTMLElement;
  // Built by createHero(), which has already run by the time this is wired.
  const finder = document.querySelector('.finder') as HTMLElement;

  const popover = document.createElement('div');
  popover.className = 'nav-popover';
  popover.hidden = true;
  document.body.append(popover);

  function close(options?: { restoreFocus?: boolean }): void {
    if (popover.hidden) return;
    popover.hidden = true;
    popover.replaceChildren();
    button.setAttribute('aria-expanded', 'false');
    if (options?.restoreFocus) button.focus();
  }

  function open(): void {
    const rect = button.getBoundingClientRect();
    // Right-aligned to the button and then pulled back inside the viewport. The button
    // sits at the right edge of the strip, so a panel hung from its left corner would
    // run off the screen on a phone.
    const width = Math.min(300, window.innerWidth - 16);
    popover.style.top = `${rect.bottom + 8}px`;
    popover.style.left = `${Math.max(8, rect.right - width)}px`;
    // Rebuilt on every open rather than kept between them. Its one job is "here's the
    // place you're looking at, type to replace it," and a list left over from the last
    // open would say otherwise.
    const picker = createPicker(popover, {
      id: 'nav-search',
      label: 'Find a place',
      placeholder: 'Santa Monica, Venice...',
      places: bundle.ordered,
      onSelect: (slug) => {
        onSelect(slug);
        close({ restoreFocus: true });
      },
    });
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const current = store.current.selection?.label;
    if (current) picker.setValue(current);
    picker.focus();
  }

  // The masthead covers the top of the viewport, so an element scrolled underneath it
  // still counts as intersecting. Shrinking the observer's root by the strip's own
  // height is what makes "hidden behind the masthead" mean gone. Measured once: the
  // strip grows by a line for the three longest place names, which moves the reveal
  // point by about 20px on a page thousands of pixels tall.
  const observer = new IntersectionObserver(
    ([entry]) => {
      const gone = entry ? !entry.isIntersecting : false;
      button.hidden = !gone;
      chip.hidden = gone;
      // Scrolling the real search box back into view retires this one mid-use rather
      // than leaving a panel hanging over a control that can now do the same job.
      if (!gone) close();
    },
    { rootMargin: `-${masthead.offsetHeight}px 0px 0px 0px` },
  );
  observer.observe(finder);

  button.addEventListener('click', () => {
    if (popover.hidden) open();
    else close({ restoreFocus: true });
  });

  document.addEventListener('click', (event) => {
    if (popover.hidden) return;
    const target = event.target as Node;
    if (popover.contains(target) || button.contains(target)) return;
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close({ restoreFocus: true });
  });
}

/**
 * The masthead names the place on screen — "Downtown LA Feels Like" — rather than
 * carrying a fixed brand name above a page that is about to say the same thing again in
 * the summary panel below it.
 *
 * A label, not a control. An earlier version made the place name a dropdown trigger,
 * which put a second place picker roughly 60 pixels above the one in the summary panel —
 * and, because the masthead does not stick, opening it covered the very box it
 * duplicated. Changing place happens in one place on this page.
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
        ? `<span class="wordmark-place">${name}</span> <strong>Feels Like</strong>`
        : `<span class="wordmark-place">${name}</span> LA <strong>Feels Like</strong>`;
}

/**
 * The tab title, plain text and unescaped (it never touches innerHTML), same naming
 * rule as the wordmark above. A generic "Feels Like LA" on every tab is a missed
 * signal twice over: for a reader with several places open at once, and for a crawler
 * that lands directly on /del-rey and would otherwise see no title distinguishing it
 * from the homepage.
 */
function writeTitle(bundle: Bundle, selection: Selection | null): void {
  const place = selection?.slug ? bundle.places.get(selection.slug) : null;
  const name = selection?.label ?? null;
  document.title =
    name === null
      ? 'Feels Like LA'
      : place?.source_type === 'standalone-city'
        ? `${name} Feels Like | Feels Like LA`
        : `${name} LA Feels Like | Feels Like LA`;
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
  chip.textContent = state.state === 'current' ? 'Local forecast' : state.message;
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
      <p class="credit">© <a href="https://mattstiles.me">Matt Stiles</a>, 2026</p>
    </details>
  `;
}

void start();
