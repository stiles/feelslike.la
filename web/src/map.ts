// The countywide map.
//
// The basemap is a Mapbox Standard style, so the reader gets water, neighboring counties
// and collision-managed place labels for free — in Mapbox's own basemap type, not the
// page's, since a style's text-font isn't something a page's CSS reaches. Our layers go
// into Standard's `middle` slot: above the roads, below the labels. That ordering is what lets
// the bands stay fully opaque, which in turn is what lets the legend be truthful. A
// semi-transparent choropleth shows the reader a color that is not in the key.
//
// If the basemap cannot load, the map falls back to a style built only from this build's
// own GeoJSON and keeps drawing temperatures. The forecast never depends on a tile
// provider being reachable.

import mapboxgl, {
  type DataDrivenPropertyValueSpecification,
  type LayerSpecification,
  type Map as MapboxMap,
  type SourceSpecification,
} from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { escape } from './format';
import type { Bundle, Selection } from './types';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';
const STYLE =
  import.meta.env.VITE_MAPBOX_STYLE ?? 'mapbox://styles/stiles/cmiuh91nz003q01su2wd5b64l';

/**
 * The opening view: the San Fernando Valley down through the South Bay, not the county's
 * legal extent.
 *
 * The card beside this map is taller than it is wide, so the map is too — this bbox is
 * close to square (roughly 69km by 70km) rather than the basin's own wide, short shape,
 * because fitBounds zooms out to whichever dimension is tighter. A wide bbox in a tall
 * container reveals extra land above and below what's asked for, not just to the sides:
 * that is what used to push Lancaster and Catalina into the opening view.
 *
 * What it leaves out is deliberate. The county reaches to the Antelope Valley and out to
 * San Clemente Island, and Ventura's Fillmore and San Bernardino's Ontario are context,
 * not the story. All of them are still in the place index and still searchable; the map
 * pans to a selection that starts off screen, and the reset control brings this view back.
 */
const LA_VIEW: [[number, number], [number, number]] = [
  [-118.7, 33.7],
  [-117.95, 34.33],
];

// Read from the style at build time and overridden here rather than in Studio, because
// these are this product's needs rather than the style's defaults.
const BASEMAP_CONFIG = {
  // The bands are opaque, so the roads under them are hidden and their labels would be
  // shields floating over temperatures with nothing to attach to.
  showRoadLabels: false,
  showPointOfInterestLabels: false,
  showTransitLabels: false,
  // A flat data map. Extruded buildings at this zoom are noise at best.
  show3dObjects: false,
  // Inter is both the page's own font (see main.ts) and one of Mapbox Standard's
  // supported basemap fonts, so the neighborhood labels read as one typeface with the
  // rest of the page instead of Mapbox's default.
  font: 'Inter',
};

export interface MapView {
  showFrame(frame: GeoJSON.FeatureCollection): void;
  showOutlines(outlines: GeoJSON.FeatureCollection): void;
  showCounty(county: GeoJSON.FeatureCollection): void;
  highlight(selection: Selection | null, comparison: string | null): void;
  resize(): void;
  /**
   * What the map has actually drawn, for the smoke harness and the console.
   *
   * A map can start, size itself and report no errors while drawing nothing, so
   * "did it render" has to be a question something can ask rather than a look.
   */
  drawn(): {
    basemap: boolean;
    bands: number;
    outlines: number;
    context: number;
    selected: number;
    comparison: number;
  };
  bandAt(longitude: number, latitude: number): number | null;
  /** A coordinate's position in the map container, in pixels — for the smoke harness
   * to know where to click. */
  project(longitude: number, latitude: number): { x: number; y: number };
}

export function createMap(
  container: HTMLElement,
  bundle: Bundle,
  onSelect: (slug: string) => void,
): MapView {
  const bandColors = paint(bundle);
  const withBasemap = Boolean(TOKEN);
  if (withBasemap) mapboxgl.accessToken = TOKEN;

  const map = new mapboxgl.Map({
    container,
    style: withBasemap ? STYLE : localStyle(bundle),
    // The saved style opens on a globe at zoom 2. A county-scale data map wants
    // mercator: flat, predictable under fitBounds, and matching the projection the
    // contours were generated for.
    projection: 'mercator',
    // Framed from the constant above rather than from the county geometry, so the first
    // paint is already the right view instead of a guessed center that jumps when
    // county.geojson lands.
    bounds: LA_VIEW,
    fitBoundsOptions: { padding: 0 },
    minZoom: 7.4,
    // The grid is 2.5 km. Past this the reader is zooming into a band edge that is an
    // interpolation, not a boundary anyone could stand on.
    maxZoom: 12,
    dragRotate: false,
    pitchWithRotate: false,
    // The map is a companion to the card, not the primary control, and a scroll that
    // zooms instead of scrolling the page is the wrong default on a phone.
    scrollZoom: false,
    // A one-finger touch pans the map instead of scrolling the page underneath it —
    // the same reasoning as scrollZoom above, for touch. Requiring a second finger to
    // move the map (Mapbox's own fix for this, matching Google Maps' default) leaves a
    // single finger free to scroll past the map like any other part of the page.
    cooperativeGestures: true,
    // Mapbox attribution stays. It is a condition of using their tiles, and the
    // credit line in the footer covers the forecast and the boundaries separately.
    attributionControl: true,
  });

  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();

  // Everything the map should be showing, held in one place and re-applied on load.
  //
  // The style is not ready the moment the map is constructed, and a call that arrives
  // early has to be replayed rather than dropped.
  const wanted: {
    frame: GeoJSON.FeatureCollection | null;
    outlines: GeoJSON.FeatureCollection | null;
    county: GeoJSON.FeatureCollection | null;
    selected: string;
    comparison: string;
    hovered: string;
    label: { name: string; longitude: number; latitude: number } | null;
  } = {
    frame: null,
    outlines: null,
    county: null,
    selected: '',
    comparison: '',
    hovered: '',
    label: null,
  };

  const applied: { frame?: unknown; outlines?: unknown; county?: unknown; filters?: string } = {};
  let basemap = withBasemap;
  let installed = false;
  let fellBack = false;

  /** Add our sources and layers to whichever style is loaded. */
  function install(): void {
    for (const [id, spec] of Object.entries(sources())) {
      if (!map.getSource(id)) map.addSource(id, spec);
    }
    for (const layer of layers(bundle, bandColors)) {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    installed = true;
    if (basemap) {
      for (const [key, value] of Object.entries(BASEMAP_CONFIG)) {
        try {
          map.setConfigProperty('basemap', key, value);
        } catch {
          // A style without that property is not a problem worth surfacing.
        }
      }
    }
    flush();
  }

  /**
   * Push whatever is wanted and can be applied right now.
   *
   * Each piece is guarded on its own source or layer existing rather than on
   * `isStyleLoaded()`. That global check reads false while any source is still loading,
   * which is most of the first few seconds, and gating on it dropped every update that
   * landed in that window: scrubbing to a new hour left the map on the old one, four
   * temperature classes away from the card.
   */
  function flush(): void {
    const frames = source('frame');
    if (wanted.frame && frames && applied.frame !== wanted.frame) {
      frames.setData(wanted.frame);
      applied.frame = wanted.frame;
    }
    const shapes = source('outlines');
    if (wanted.outlines && shapes && applied.outlines !== wanted.outlines) {
      shapes.setData(wanted.outlines);
      applied.outlines = wanted.outlines;
    }
    const silhouette = source('county');
    if (wanted.county && silhouette && applied.county !== wanted.county) {
      silhouette.setData(wanted.county);
      applied.county = wanted.county;
    }

    const filters = `${wanted.selected}|${wanted.comparison}|${wanted.hovered}`;
    if (map.getLayer('selected-line') && applied.filters !== filters) {
      for (const layer of ['selected-casing', 'selected-line']) {
        map.setFilter(layer, ['==', ['get', 'slug'], wanted.selected]);
      }
      map.setFilter('comparison-line', ['==', ['get', 'slug'], wanted.comparison]);
      map.setFilter('hover-line', ['==', ['get', 'slug'], wanted.hovered]);
      applied.filters = filters;
    }
  }

  function source(id: string): mapboxgl.GeoJSONSource | undefined {
    return map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
  }

  map.on('style.load', install);
  map.on('idle', flush);

  /**
   * Fall back to our own geometry if the basemap cannot load.
   *
   * A missing token, a network failure, an expired account: the reader still gets the
   * temperatures, drawn from files this build published, with the curated place labels
   * standing in for the ones the basemap would have supplied.
   */
  map.on('error', (event) => {
    const message = String((event as { error?: Error }).error?.message ?? '');
    const styleFailed = !installed || /style|sprite|glyph|token|access/i.test(message);
    if (!basemap || fellBack || !styleFailed) return;
    fellBack = true;
    basemap = false;
    installed = false;
    applied.frame = applied.outlines = applied.county = applied.filters = undefined;
    map.setStyle(localStyle(bundle));
  });

  const labels = createLabels(container, map, bundle, () => basemap);
  const reset = createReset(container, map);

  /**
   * Hover and tap on `outlines-fill`, the invisible layer that makes every neighborhood
   * clickable at every zoom.
   *
   * `mousemove`/`mouseleave` are Mapbox's own layer-scoped delegation: they fire only
   * for this layer, already hit-tested, so there's no manual `queryRenderedFeatures`
   * here. A tap on a touch device fires `click` the same way a mouse click does, so
   * selecting a place off the map costs nothing extra for a phone.
   */
  map.on('mousemove', 'outlines-fill', (event) => {
    const feature = event.features?.[0];
    const slug = String(feature?.properties?.slug ?? '');
    if (!slug) return;
    map.getCanvas().style.cursor = 'pointer';
    if (wanted.hovered !== slug) {
      wanted.hovered = slug;
      flush();
    }
    labels.hover({
      x: event.point.x,
      y: event.point.y,
      name: String(feature?.properties?.name ?? ''),
    });
  });

  map.on('mouseleave', 'outlines-fill', () => {
    map.getCanvas().style.cursor = '';
    if (wanted.hovered !== '') {
      wanted.hovered = '';
      flush();
    }
    labels.hover(null);
  });

  map.on('click', 'outlines-fill', (event) => {
    const slug = event.features?.[0]?.properties?.slug;
    if (typeof slug === 'string' && slug) onSelect(slug);
  });

  /**
   * Bring a selection into view if the LA frame does not contain it.
   *
   * The Antelope Valley and Catalina are outside the opening view but inside the place
   * index, so a reader who searches Lancaster would otherwise get a highlighted outline
   * they cannot see and a map that looks broken. Panning keeps the current zoom: the
   * question is where, not how close.
   */
  function reveal(point: { longitude: number; latitude: number }): void {
    const screen = map.project([point.longitude, point.latitude]);
    const margin = 48;
    const outside =
      screen.x < margin ||
      screen.y < margin ||
      screen.x > container.clientWidth - margin ||
      screen.y > container.clientHeight - margin;
    if (!outside) return;
    map.easeTo({ center: [point.longitude, point.latitude], duration: 600 });
    reset.offer();
  }

  return {
    showFrame(frame) {
      wanted.frame = frame;
      flush();
    },
    showOutlines(collection) {
      wanted.outlines = collection;
      flush();
    },
    showCounty(collection) {
      wanted.county = collection;
      flush();
      labels.place();
    },
    highlight(selection, comparison) {
      wanted.selected = selection?.slug ?? '';
      wanted.comparison = comparison ?? '';
      flush();
      const point = selection ? mark(bundle, selection) : null;
      labels.select(point);
      if (point) reveal(point);
    },
    resize() {
      map.resize();
      labels.place();
    },
    drawn() {
      return {
        basemap,
        bands: rendered(map, 'bands'),
        outlines: map.getSource('outlines') ? map.querySourceFeatures('outlines').length : 0,
        context: rendered(map, 'place-lines'),
        selected: rendered(map, 'selected-line'),
        comparison: rendered(map, 'comparison-line'),
      };
    },
    bandAt(longitude, latitude) {
      if (!map.getLayer('bands')) return null;
      const point = map.project([longitude, latitude]);
      const [feature] = map.queryRenderedFeatures(point, { layers: ['bands'] });
      const band = feature?.properties?.band_id;
      return typeof band === 'number' ? band : null;
    },
    project(longitude, latitude) {
      const point = map.project([longitude, latitude]);
      return { x: point.x, y: point.y };
    },
  };
}

/** The fill expression, built from the manifest's legend so the two cannot drift apart. */
function paint(bundle: Bundle): DataDrivenPropertyValueSpecification<string> {
  return [
    'match',
    ['get', 'band_id'],
    ...bundle.manifest.display.bands.flatMap((band) => [band.band_id, band.color]),
    // A class with no entry falls through to the no-data gray rather than borrowing a
    // neighboring temperature's color.
    bundle.manifest.display.no_data_color,
  ] as unknown as DataDrivenPropertyValueSpecification<string>;
}

function sources(): Record<string, SourceSpecification> {
  return {
    frame: { type: 'geojson', data: empty() },
    // `promoteId` keys feature-state by slug rather than Mapbox's own auto-assigned
    // numeric id, so the hover filter below can be driven by the same slug every other
    // layer already filters on.
    outlines: { type: 'geojson', data: empty(), promoteId: 'slug' },
    county: { type: 'geojson', data: empty() },
  };
}

/**
 * Our layers, in draw order.
 *
 * `slot: 'middle'` puts them above Standard's roads and below its labels. In the
 * fallback style there are no slots and the property is ignored, so one list serves both.
 */
function layers(
  bundle: Bundle,
  bandColors: DataDrivenPropertyValueSpecification<string>,
): LayerSpecification[] {
  const slot = 'middle' as const;
  return [
    {
      id: 'county-fill',
      type: 'fill',
      source: 'county',
      slot,
      // Under the bands, so a cell with no forecast reads as a gray hole instead of
      // showing the basemap through it.
      paint: { 'fill-color': bundle.manifest.display.no_data_color, 'fill-opacity': 0 },
    },
    {
      id: 'bands',
      type: 'fill',
      source: 'frame',
      slot,
      paint: { 'fill-color': bandColors, 'fill-opacity': .5 },
    },
    // Invisible, and the whole point of it: a fill covers every neighborhood at every
    // zoom, including where `place-lines` below hasn't faded in yet, so hover and click
    // both work before a reader has zoomed in far enough to see a single boundary.
    {
      id: 'outlines-fill',
      type: 'fill',
      source: 'outlines',
      slot,
      paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
    },
    {
      id: 'place-lines',
      type: 'line',
      source: 'outlines',
      slot,
      // Invisible at the opening zoom, where 270-odd neighborhood boundaries would just
      // be noise on top of the temperature field; they fade in once the reader has
      // zoomed or selected a place close enough for them to be useful context rather
      // than clutter — see Priority 4, "hide most neighborhood outlines at initial zoom."
      paint: {
        'line-color': '#262626',
        'line-width': 0.3,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, 0.16],
      },
    },
    // One filter, updated on every hover, the same pattern as selected/comparison below
    // rather than a separate always-on layer — lighter than either, since this is a
    // "here's what that is" cue, not a second selection.
    {
      id: 'hover-line',
      type: 'line',
      source: 'outlines',
      slot,
      filter: ['==', ['get', 'slug'], ''],
      paint: { 'line-color': '#262626', 'line-width': 1.5, 'line-opacity': 0.6 },
    },
    {
      id: 'county-line',
      type: 'line',
      source: 'county',
      slot,
      paint: { 'line-color': '#9a9a9a', 'line-width': 0.75 },
    },
    {
      id: 'selected-casing',
      type: 'line',
      source: 'outlines',
      slot,
      filter: ['==', ['get', 'slug'], ''],
      paint: { 'line-color': '#FEFEFE', 'line-width': 4.5, 'line-opacity': 0.9 },
    },
    {
      id: 'selected-line',
      type: 'line',
      source: 'outlines',
      slot,
      filter: ['==', ['get', 'slug'], ''],
      paint: { 'line-color': '#262626', 'line-width': 2 },
    },
    {
      id: 'comparison-line',
      type: 'line',
      source: 'outlines',
      slot,
      filter: ['==', ['get', 'slug'], ''],
      paint: {
        'line-color': '#262626',
        'line-width': 1.6,
        'line-dasharray': [2, 1.6],
        'line-opacity': 0.85,
      },
    },
  ];
}

/** A style with no basemap, drawn only from this build's own files. */
function localStyle(bundle: Bundle): mapboxgl.StyleSpecification {
  return {
    version: 8,
    sources: sources(),
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#FEFEFE' } },
      ...layers(bundle, paint(bundle)),
    ],
  } as mapboxgl.StyleSpecification;
}

/**
 * HTML labels rather than a symbol layer.
 *
 * The selected place is always labeled: it is the one name the reader needs to find, and
 * the basemap has no idea which place is selected. The curated context labels only appear
 * when there is no basemap to supply its own, which is what keeps the fallback map
 * readable and keeps `label_places` in the manifest doing real work.
 *
 * HTML avoids needing glyph files in the fallback style, and with 16 places a greedy
 * collision pass gives the same sparse result a symbol layer would.
 */
function createLabels(
  container: HTMLElement,
  map: MapboxMap,
  bundle: Bundle,
  hasBasemap: () => boolean,
) {
  const layer = document.createElement('div');
  layer.className = 'map-labels';
  layer.setAttribute('aria-hidden', 'true');
  container.append(layer);

  const context = bundle.manifest.display.label_places
    .map((slug) => bundle.places.get(slug))
    .filter((place): place is NonNullable<typeof place> => Boolean(place))
    .map((place) => {
      const node = document.createElement('span');
      node.className = 'map-label';
      node.textContent = place.name;
      layer.append(node);
      return {
        node,
        longitude: place.reference_point.longitude,
        latitude: place.reference_point.latitude,
      };
    });

  const chosen = document.createElement('span');
  chosen.className = 'map-label selected';
  chosen.hidden = true;
  layer.append(chosen);
  let selected: { name: string; longitude: number; latitude: number } | null = null;

  // Follows the pointer directly rather than the feature's own geometry — it only
  // exists while the mouse is moving, so there is no "next map move" to reposition it
  // on, unlike `chosen` and `context` above.
  const hovered = document.createElement('span');
  hovered.className = 'map-label hover';
  hovered.hidden = true;
  layer.append(hovered);

  function position(
    node: HTMLElement,
    longitude: number,
    latitude: number,
    taken: DOMRect[],
  ): void {
    const point = map.project([longitude, latitude]);
    node.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`;
    node.hidden = false;
    const box = node.getBoundingClientRect();
    const inset = new DOMRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
    const offscreen =
      point.x < 4 ||
      point.y < 4 ||
      point.x > container.clientWidth - 4 ||
      point.y > container.clientHeight - 4;
    if (offscreen || taken.some((other) => overlaps(other, inset))) node.hidden = true;
    else taken.push(inset);
  }

  function place(): void {
    const taken: DOMRect[] = [];
    if (selected) {
      chosen.textContent = selected.name;
      position(chosen, selected.longitude, selected.latitude, taken);
    } else {
      chosen.hidden = true;
    }
    for (const entry of context) {
      if (hasBasemap()) {
        entry.node.hidden = true;
        continue;
      }
      position(entry.node, entry.longitude, entry.latitude, taken);
    }
  }

  map.on('move', place);
  map.on('style.load', place);

  return {
    place,
    select(next: { name: string; longitude: number; latitude: number } | null) {
      selected = next;
      place();
    },
    hover(next: { x: number; y: number; name: string } | null) {
      if (!next) {
        hovered.hidden = true;
        return;
      }
      hovered.textContent = next.name;
      hovered.style.transform = `translate(${Math.round(next.x)}px, ${Math.round(next.y)}px)`;
      hovered.hidden = false;
    },
  };
}

function mark(bundle: Bundle, selection: Selection) {
  const point = selection.slug
    ? bundle.placeCells.places[selection.slug]?.reference_point
    : undefined;
  const cell = bundle.cells.get(selection.cellId);
  const longitude = point?.[0] ?? cell?.longitude;
  const latitude = point?.[1] ?? cell?.latitude;
  if (longitude === undefined || latitude === undefined) return null;
  return { name: selection.label, longitude, latitude };
}

function rendered(map: MapboxMap, layer: string): number {
  if (!map.getLayer(layer)) return 0;
  return map.queryRenderedFeatures({ layers: [layer] }).length;
}

/**
 * A way back to the LA frame, shown only once the map has left it.
 *
 * A reader who pans to Palmdale, or who was taken there by a search, has no other way to
 * recover the view they started with, and a control that is always there is one more
 * thing to read on a phone.
 */
function createReset(container: HTMLElement, map: MapboxMap) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-reset';
  button.textContent = 'Reset map';
  button.hidden = true;
  button.addEventListener('click', () => {
    map.fitBounds(LA_VIEW, { padding: 0, duration: 600 });
    button.hidden = true;
  });
  container.append(button);

  // A drag or a zoom by the reader also earns the button. `moveend` fires for our own
  // eased moves too, so the offer is idempotent.
  map.on('dragend', () => offer());
  map.on('zoomend', () => offer());

  function offer(): void {
    button.hidden = false;
  }
  return { offer };
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
}

function empty(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * The legend, drawn from the manifest so it always describes the published classes.
 *
 * A wider gradient strip with several intermediate tick values, not just two endpoint
 * labels on a bar too thin to read precisely — see Priority 4. Each band's full label
 * is still available on hover/focus via `title`. The scale is fixed to the published
 * breaks and never rescales with the hour, so a color always means the same value.
 */
export function createLegend(root: HTMLElement, bundle: Bundle): void {
  const bands = bundle.manifest.display.bands;
  const breaks = bundle.manifest.band_breaks_f;
  const low = breaks[0] as number;
  const high = breaks[breaks.length - 1] as number;
  const span = high - low;

  // A handful of interior breaks, not all of them: with a dozen-plus bands, a tick per
  // break collides at this width. Roughly four interior ticks reads cleanly at both the
  // narrow mobile width and the wider desktop legend.
  const interiorBreaks = breaks.slice(1, -1);
  const stride = Math.max(1, Math.ceil(interiorBreaks.length / 4));
  // A stride starting at index 0 can land its first pick right next to the low
  // endpoint — e.g. 50° and 55°, five degrees apart while every other tick is fifteen —
  // and no width of scale bar fixes two adjacent labels fighting over 8% of it. An
  // endpoint label only needs room on its inward side (it's anchored outward, at 0% or
  // 100%), so half the normal tick-to-tick gap is enough headroom to drop just that
  // crowded case without also dropping a tick that was never the problem.
  const edgeGap = stride / interiorBreaks.length / 2;
  const ticks = interiorBreaks.filter((value, index) => {
    if (index % stride !== 0) return false;
    const position = ((value as number) - low) / span;
    return position > edgeGap && position < 1 - edgeGap;
  });

  root.innerHTML = `
    <p class="legend-title">Feels like (°F)</p>
    <div class="legend-scale-wrap">
      <ul class="legend-scale" title="Degrees Fahrenheit. The scale never changes with the hour.">
        ${bands
          .map(
            (band) =>
              `<li title="${escape(band.label)}"><span class="legend-swatch" style="background:${band.color}"></span></li>`,
          )
          .join('')}
      </ul>
      <div class="legend-ticks" aria-hidden="true">
        <span style="left:0%">${Math.round(low)}°</span>
        ${ticks
          .map(
            (value) =>
              `<span style="left:${(((value as number) - low) / span) * 100}%">${Math.round(value as number)}°</span>`,
          )
          .join('')}
        <span style="left:100%">${Math.round(high)}°+</span>
      </div>
    </div>
  `;
}
