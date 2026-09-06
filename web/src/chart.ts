// A compact 24-hour line, with the peak marked and a cursor on the selected hour.
//
// No area fill: a fill commits the axis to zero, and a temperature chart zeroed at 0°F
// squashes the day's variation into a band. The bare line keeps a cropped axis honest.

import { extent } from 'd3-array';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';

import { axisHour, degrees, localHour, peak } from './format';
import type { Bundle, Selection } from './types';

const NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 190;
const MARGIN = { top: 22, right: 44, bottom: 26, left: 8 };

export interface ChartView {
  render(selection: Selection | null, hour: number, comparison: string | null): void;
  clear(message: string): void;
}

export function createChart(root: HTMLElement, bundle: Bundle): ChartView {
  let width = measure();

  function measure(): number {
    return Math.max(280, root.clientWidth || 320);
  }

  const onResize = () => {
    const next = measure();
    if (Math.abs(next - width) > 8) {
      width = next;
      if (last) render(last.selection, last.hour, last.comparison);
    }
  };
  window.addEventListener('resize', onResize);

  let last: { selection: Selection | null; hour: number; comparison: string | null } | null = null;

  function clear(message: string): void {
    root.innerHTML = `<p class="empty">${message}</p>`;
  }

  function render(selection: Selection | null, hour: number, comparison: string | null): void {
    last = { selection, hour, comparison };
    if (!selection) {
      clear('Choose a place to see its 24-hour curve.');
      return;
    }
    const cell = bundle.cells.get(selection.cellId);
    if (!cell) {
      clear('No series for this location.');
      return;
    }

    const times = bundle.manifest.forecast_times;
    const series = cell.apparent_temperature_f;
    const compareCell = comparisonCell(bundle, comparison);
    const compareSeries = compareCell?.apparent_temperature_f ?? null;

    const values = [...series, ...(compareSeries ?? [])].filter(
      (value): value is number => value !== null,
    );
    if (!values.length) {
      clear('This place has no values in the current forecast window.');
      return;
    }

    const [low = 0, high = 1] = extent(values) as [number, number];
    const pad = Math.max(2, (high - low) * 0.18);
    const x = scaleLinear()
      .domain([0, times.length - 1])
      .range([MARGIN.left, width - MARGIN.right]);
    const y = scaleLinear()
      .domain([low - pad, high + pad])
      .range([HEIGHT - MARGIN.bottom, MARGIN.top]);

    const path = line<number | null>()
      .defined((value) => value !== null)
      .x((_, index) => x(index))
      .y((value) => y(value as number));

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', describe(bundle, selection, series));

    // The map's temperature bands, drawn as horizontal fills behind the line. The line
    // itself only has to show the day's shape; which band a stretch of it falls in is
    // the color already established everywhere else on the page.
    const [domainLow = low - pad, domainHigh = high + pad] = y.domain();
    for (const band of bundle.manifest.display.bands) {
      const upper = Math.min(domainHigh, band.upper_f ?? domainHigh);
      const lower = Math.max(domainLow, band.lower_f ?? domainLow);
      if (upper <= lower) continue;
      add(svg, 'rect', {
        x: MARGIN.left,
        y: y(upper),
        width: width - MARGIN.left - MARGIN.right,
        height: Math.max(0, y(lower) - y(upper)),
        fill: band.color,
        opacity: 0.55,
        class: 'band-fill',
      });
    }

    // Tick labels at whole tens. The bands already divide the field; a gridline on top
    // of them would either vanish against a dark class or fight its color.
    for (const value of y.ticks(4)) {
      add(svg, 'text', { x: width - MARGIN.right + 6, y: y(value) + 4, class: 'tick' }).textContent =
        `${Math.round(value)}°`;
    }

    // Midnight rule, so a curve crossing into tomorrow reads as two days.
    times.forEach((stamp, index) => {
      if (index > 0 && localHour(stamp) === 0) {
        add(svg, 'line', {
          x1: x(index),
          x2: x(index),
          y1: MARGIN.top - 8,
          y2: HEIGHT - MARGIN.bottom,
          class: 'daybreak',
        });
        add(svg, 'text', { x: x(index) + 4, y: MARGIN.top - 12, class: 'daybreak-label' }).textContent =
          'midnight';
      }
    });

    // The cursor sits under the lines: it locates the hour without hiding the data.
    add(svg, 'line', {
      x1: x(hour),
      x2: x(hour),
      y1: MARGIN.top - 4,
      y2: HEIGHT - MARGIN.bottom,
      class: 'cursor',
    });

    // A white casing under each line, the same trick the map uses for the selected
    // outline: the bands behind the line are any color, so the line needs its own
    // contrast rather than borrowing the background's.
    if (compareSeries) {
      const d = path(compareSeries) ?? '';
      add(svg, 'path', { d, class: 'series-casing', 'stroke-width': 3.4 });
      add(svg, 'path', { d, class: 'series comparison' });
    }
    {
      const d = path(series) ?? '';
      add(svg, 'path', { d, class: 'series-casing', 'stroke-width': 4.2 });
      add(svg, 'path', { d, class: 'series primary' });
    }

    const high24 = peak(series);
    if (high24) {
      add(svg, 'circle', {
        cx: x(high24.index),
        cy: y(high24.value),
        r: 4,
        class: 'peak-dot',
      });
      const anchor = high24.index > times.length * 0.7 ? 'end' : 'start';
      add(svg, 'text', {
        x: x(high24.index) + (anchor === 'end' ? -8 : 8),
        y: y(high24.value) - 9,
        class: 'peak-label',
        'text-anchor': anchor,
      }).textContent = `Peak ${degrees(high24.value)}`;
    }

    const atHour = series[hour];
    if (atHour !== null && atHour !== undefined) {
      add(svg, 'circle', { cx: x(hour), cy: y(atHour), r: 4.5, class: 'cursor-dot' });
    }

    // Hour labels every six hours, plus the last, so a 320px board stays readable.
    times.forEach((stamp, index) => {
      if (index % 6 !== 0 && index !== times.length - 1) return;
      add(svg, 'text', {
        x: x(index),
        y: HEIGHT - 8,
        class: 'tick',
        'text-anchor': index === times.length - 1 ? 'end' : index === 0 ? 'start' : 'middle',
      }).textContent = axisHour(stamp);
    });

    root.replaceChildren(svg);
    if (compareCell && comparison) {
      const name = bundle.places.get(comparison)?.name ?? comparison;
      const key = document.createElement('p');
      key.className = 'chart-key';
      key.innerHTML = `<span class="key primary">${escapeText(selection.label)}</span><span class="key comparison">${escapeText(name)}</span>`;
      root.append(key);
    }
  }

  return { render, clear };
}

function comparisonCell(bundle: Bundle, comparison: string | null) {
  if (!comparison) return null;
  const cellId = bundle.placeCells.places[comparison]?.cell_id;
  return cellId ? bundle.cells.get(cellId) ?? null : null;
}

function describe(bundle: Bundle, selection: Selection, series: (number | null)[]): string {
  const high = peak(series);
  const first = bundle.manifest.forecast_times[0];
  const last = bundle.manifest.forecast_times[bundle.manifest.forecast_times.length - 1];
  const window = first && last ? ` from ${axisHour(first)} to ${axisHour(last)}` : '';
  return high
    ? `Apparent temperature for ${selection.label}${window}, peaking near ${Math.round(high.value)} degrees.`
    : `Apparent temperature for ${selection.label}${window}. No values available.`;
}

function add(
  parent: SVGElement,
  name: string,
  attributes: Record<string, string | number>,
): SVGElement {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  parent.append(element);
  return element;
}

function escapeText(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
