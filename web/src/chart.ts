// A compact 24-hour line, with the peak marked and a cursor on the selected hour.
//
// No area fill for the axis's sake, and no rainbow bands behind the line: the plot's job
// is the day's shape, not a second legend. The map already carries color; this stays
// neutral so the line is the only thing competing for attention — see Priority 5.

import { extent } from 'd3-array';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';

import { dateLabel, degrees, difference, localHour, peak, weekdayHour } from './format';
import type { Bundle, Selection } from './types';

const NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 190;
const MARGIN = { top: 28, right: 44, bottom: 26, left: 8 };

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
    const compareName = comparison ? bundle.places.get(comparison)?.name ?? comparison : null;

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
    // A fresh element every render, so the built-in fade-in (see #chart svg in
    // styles.css) replays on every hour scrub — a soft cross-fade instead of a snap.
    svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', describe(bundle, selection, series));

    // Subtle horizontal gridlines and degree labels, on a plain plot background — no
    // band fills competing with the line for the reader's eye.
    for (const value of y.ticks(4)) {
      add(svg, 'line', {
        x1: MARGIN.left,
        x2: width - MARGIN.right,
        y1: y(value),
        y2: y(value),
        class: 'chart-gridline',
      });
      add(svg, 'text', { x: width - MARGIN.right + 6, y: y(value) + 4, class: 'tick' }).textContent =
        `${Math.round(value)}°`;
    }

    // Day transition: a date label, not just "midnight" — it says what changed.
    times.forEach((stamp, index) => {
      if (index > 0 && localHour(stamp) === 0) {
        add(svg, 'line', {
          x1: x(index),
          x2: x(index),
          y1: MARGIN.top - 10,
          y2: HEIGHT - MARGIN.bottom,
          class: 'daybreak',
        });
        add(svg, 'text', { x: x(index) + 4, y: MARGIN.top - 14, class: 'daybreak-label' }).textContent =
          dateLabel(stamp);
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

    // A very faint fill under the primary line only — texture, not a second band of
    // saturated color.
    {
      const area = line<number | null>()
        .defined((value) => value !== null)
        .x((_, index) => x(index))
        .y((value) => y(value as number));
      const top = area(series) ?? '';
      const baseY = HEIGHT - MARGIN.bottom;
      const fillPath = `${top} L ${x(times.length - 1)} ${baseY} L ${x(0)} ${baseY} Z`;
      add(svg, 'path', { d: fillPath, class: 'series-fill' });
    }

    // A white casing under each line, the same trick the map uses for the selected
    // outline: the plot behind the line can vary, so the line needs its own contrast
    // rather than borrowing the background.
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
      const labelY = Math.max(MARGIN.top - 10, y(high24.value) - 9);
      add(svg, 'text', {
        x: x(high24.index) + (anchor === 'end' ? -8 : 8),
        y: labelY,
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
      }).textContent = weekdayHour(stamp).replace(/^\w{3}\s/, '');
    });

    root.replaceChildren(svg);

    if (compareCell && comparison && compareName) {
      const key = document.createElement('p');
      key.className = 'chart-key';
      key.innerHTML = `<span class="key primary">${escapeText(selection.label)}</span><span class="key comparison">${escapeText(compareName)}</span>`;
      root.append(key);
    }

    const summary = document.createElement('p');
    summary.className = 'chart-summary';
    summary.textContent = summarize(selection, series, hour, high24, compareName, compareSeries);
    root.append(summary);
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
  const window = first && last ? ` from ${weekdayHour(first)} to ${weekdayHour(last)}` : '';
  return high
    ? `Apparent temperature for ${selection.label}${window}, peaking near ${Math.round(high.value)} degrees.`
    : `Apparent temperature for ${selection.label}${window}. No values available.`;
}

/** A short visible sentence covering the same ground as the line, for anyone who wants
 * the numbers without reading the chart. */
function summarize(
  selection: Selection,
  series: (number | null)[],
  hour: number,
  high: { index: number; value: number } | null,
  compareName: string | null,
  compareSeries: (number | null)[] | null,
): string {
  const atHour = series[hour];
  const parts: string[] = [];
  if (atHour !== null && atHour !== undefined) {
    parts.push(`${selection.label} ${degrees(atHour)} at the selected hour`);
  }
  if (high) parts.push(`peak ${degrees(high.value)}`);
  if (compareName && compareSeries) {
    const theirs = compareSeries[hour];
    const gap = theirs !== undefined ? difference(atHour ?? null, theirs ?? null) : null;
    if (gap) {
      parts.push(
        gap.word === 'the same'
          ? `about the same as ${compareName}`
          : `${gap.degrees}° ${gap.word} than ${compareName}`,
      );
    }
  }
  return parts.join(' · ');
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
