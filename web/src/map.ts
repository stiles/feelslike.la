// The countywide map.
//
// The style is built entirely from this build's own GeoJSON: no tile provider, no glyph
// server, no API key. That is partly a reliability choice, since the only thing that can
// fail is the frame fetch, and partly an honesty one, since a street basemap under a
// 2.5 km forecast grid implies detail the data does not have.
//
// Labels are HTML markers rather than a symbol layer, because a symbol layer needs
// glyph PBFs from a font server. With a curated list of 16 places a greedy collision
// pass gives the same sparse result without the dependency.

import maplibregl, {
  type DataDrivenPropertyValueSpecification,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { escape } from './card';
import type { Bundle, Selection } from './types';

// A first view for the moment before the county silhouette arrives, after which the map
// frames itself from the real geometry.
const OPENING_VIEW = {
  center: [-118.29, 34.19] as [number, number],
  zoom: 8.1,
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
  drawn(): { bands: number; selected: number; comparison: number };
  bandAt(longitude: number, latitude: number): number | null;
}

export function createMap(container: HTMLElement, bundle: Bundle): MapView {
  const bands = bundle.manifest.display.bands;

  // Built from the manifest's legend, so the fills and the legend cannot drift apart. A
  // class with no entry falls through to the no-data gray rather than borrowing a
  // neighboring temperature's color. Cast because the spread loses the tuple shape
  // MapLibre's expression types require.
  const bandColors = [
    'match',
    ['get', 'band_id'],
    ...bands.flatMap((band) => [band.band_id, band.color]),
    bundle.manifest.display.no_data_color,
  ] as unknown as DataDrivenPropertyValueSpecification<string>;

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        frame: { type: 'geojson', data: empty() },
        outlines: { type: 'geojson', data: empty() },
        county: { type: 'geojson', data: empty() },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#FEFEFE' } },
        {
          id: 'county-fill',
          type: 'fill',
          source: 'county',
          // Under the bands, so a cell with no forecast reads as a gray hole instead of
          // showing the page through it.
          paint: { 'fill-color': bundle.manifest.display.no_data_color, 'fill-opacity': 1 },
        },
        {
          id: 'bands',
          type: 'fill',
          source: 'frame',
          paint: { 'fill-color': bandColors, 'fill-opacity': 1 },
        },
        {
          id: 'band-edges',
          type: 'line',
          source: 'frame',
          paint: { 'line-color': '#FEFEFE', 'line-width': 0.4, 'line-opacity': 0.5 },
        },
        {
          id: 'place-lines',
          type: 'line',
          source: 'outlines',
          paint: { 'line-color': '#262626', 'line-width': 0.3, 'line-opacity': 0.16 },
        },
        {
          id: 'county-line',
          type: 'line',
          source: 'county',
          // The coastline and county line. Without it, an afternoon in the 60s is a pale
          // shape on a pale page with no silhouette to recognize.
          paint: { 'line-color': '#7d97a8', 'line-width': 0.9 },
        },
        {
          id: 'selected-casing',
          type: 'line',
          source: 'outlines',
          filter: ['==', ['get', 'slug'], ''],
          paint: { 'line-color': '#FEFEFE', 'line-width': 4.5, 'line-opacity': 0.9 },
        },
        {
          id: 'selected-line',
          type: 'line',
          source: 'outlines',
          filter: ['==', ['get', 'slug'], ''],
          paint: { 'line-color': '#262626', 'line-width': 2 },
        },
        {
          id: 'comparison-line',
          type: 'line',
          source: 'outlines',
          filter: ['==', ['get', 'slug'], ''],
          paint: {
            'line-color': '#262626',
            'line-width': 1.6,
            'line-dasharray': [2, 1.6],
            'line-opacity': 0.85,
          },
        },
      ],
    },
    center: OPENING_VIEW.center,
    zoom: OPENING_VIEW.zoom,
    minZoom: 7.4,
    maxZoom: 12,
    attributionControl: false,
    dragRotate: false,
    // The map is a companion to the card, not the primary control, and a scroll that
    // zooms instead of scrolling the page is the wrong default on a phone.
    scrollZoom: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();

  const labelLayer = document.createElement('div');
  labelLayer.className = 'map-labels';
  labelLayer.setAttribute('aria-hidden', 'true');
  container.append(labelLayer);

  const labels = bundle.manifest.display.label_places
    .map((slug) => bundle.places.get(slug))
    .filter((place): place is NonNullable<typeof place> => Boolean(place))
    .map((place) => {
      const node = document.createElement('span');
      node.className = 'map-label';
      node.innerHTML = escape(place.name);
      labelLayer.append(node);
      return { place, node };
    });

  /** Greedy collision: earlier entries in the configured order keep their place. */
  function placeLabels(): void {
    const taken: DOMRect[] = [];
    for (const { place, node } of labels) {
      const point = map.project([
        place.reference_point.longitude,
        place.reference_point.latitude,
      ]);
      node.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`;
      node.hidden = false;
      const box = node.getBoundingClientRect();
      const inset = new DOMRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
      const clashes =
        taken.some((other) => overlaps(other, inset)) ||
        point.x < 4 ||
        point.y < 4 ||
        point.x > container.clientWidth - 4 ||
        point.y > container.clientHeight - 4;
      if (clashes) node.hidden = true;
      else taken.push(inset);
    }
  }

  map.on('move', placeLabels);
  map.on('load', placeLabels);

  // Everything the map should be showing, held in one place and re-applied on load.
  //
  // The style is not ready the moment the map is constructed, and a call that arrives
  // early has to be replayed rather than dropped. Doing that for the data but not for
  // the highlight filters is what left the selected place unoutlined: the filter was
  // set against a layer that did not exist yet, and nothing asked again.
  const wanted: {
    frame: GeoJSON.FeatureCollection | null;
    outlines: GeoJSON.FeatureCollection | null;
    county: GeoJSON.FeatureCollection | null;
    selected: string;
    comparison: string;
  } = { frame: null, outlines: null, county: null, selected: '', comparison: '' };

  // What has actually reached the map, so a repeat flush does not re-parse geometry that
  // is already there.
  const applied: { frame?: unknown; outlines?: unknown; county?: unknown; filters?: string } = {};

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

    const filters = `${wanted.selected}|${wanted.comparison}`;
    if (map.getLayer('selected-line') && applied.filters !== filters) {
      filter('selected-casing', wanted.selected);
      filter('selected-line', wanted.selected);
      filter('comparison-line', wanted.comparison);
      applied.filters = filters;
    }
  }

  function source(id: string): maplibregl.GeoJSONSource | undefined {
    return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  }

  function filter(layer: string, slug: string): void {
    if (map.getLayer(layer)) map.setFilter(layer, ['==', ['get', 'slug'], slug]);
  }

  map.on('load', flush);
  map.on('styledata', flush);
  map.on('idle', flush);

  let framed = false;

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
      // Frame the county from its own geometry rather than a zoom chosen by eye, so a
      // phone, a tablet and a desktop all open on the whole county. The Channel Islands
      // are in the boundary and would pull the frame far south, so the bounds come from
      // the mainland part.
      const bounds = mainlandBounds(collection);
      if (bounds && !framed) {
        framed = true;
        map.fitBounds(bounds, { padding: 12, animate: false, maxZoom: 10 });
        placeLabels();
      }
    },
    highlight(selection, comparison) {
      wanted.selected = selection?.slug ?? '';
      wanted.comparison = comparison ?? '';
      flush();
    },
    resize() {
      map.resize();
      placeLabels();
    },
    drawn() {
      return {
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
  };
}

function rendered(map: MapLibreMap, layer: string): number {
  if (!map.getLayer(layer)) return 0;
  return map.queryRenderedFeatures({ layers: [layer] }).length;
}

/**
 * Bounds of the largest ring, which is the mainland county.
 *
 * Including Catalina and San Clemente would push the frame roughly 60 miles south and
 * leave the basin, where most readers are, in the top third of the map.
 */
function mainlandBounds(
  collection: GeoJSON.FeatureCollection,
): [[number, number], [number, number]] | null {
  const geometry = collection.features[0]?.geometry;
  if (!geometry) return null;
  const polygons =
    geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : [];
  let best: GeoJSON.Position[] | null = null;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (ring && (!best || ring.length > best.length)) best = ring;
  }
  if (!best) return null;

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const point of best) {
    const [longitude, latitude] = point as [number, number];
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return [
    [west, south],
    [east, north],
  ];
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
}

function empty(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** The legend, drawn from the manifest so it always describes the published classes. */
export function createLegend(root: HTMLElement, bundle: Bundle): void {
  const bands = bundle.manifest.display.bands;
  root.innerHTML = `
    <p class="legend-title">Feels like</p>
    <ul class="legend-scale">
      ${bands
        .map(
          (band) => `
        <li title="${escape(band.label)}">
          <span class="legend-swatch" style="background:${band.color}"></span>
          <span class="legend-tick">${band.lower_f === null ? '' : Math.round(band.lower_f)}</span>
        </li>`,
        )
        .join('')}
    </ul>
    <p class="legend-note">Degrees Fahrenheit. The scale never changes with the hour.</p>
  `;
}
