// The forecast card: place, hour, feels-like temperature, air temperature, peak.

import { degrees, hourLabel, peak, whole } from './format';
import type { Bundle, Selection } from './types';

export interface CardView {
  render(selection: Selection | null, hour: number): void;
  showLoading(): void;
  showProblem(message: string): void;
}

export function createCard(root: HTMLElement, bundle: Bundle): CardView {
  const section = root.closest('section');

  function showLoading(): void {
    section?.setAttribute('aria-busy', 'true');
    root.innerHTML = `
      <p class="card-place skeleton-text" id="card-place">Loading the forecast</p>
      <p class="card-hour">&nbsp;</p>
    `;
  }

  function showProblem(message: string): void {
    section?.setAttribute('aria-busy', 'false');
    root.innerHTML = `
      <p class="card-place" id="card-place">No forecast</p>
      <p class="card-problem">${escape(message)}</p>
      <p class="card-hint">Search for a neighborhood, city or unincorporated area above.</p>
    `;
  }

  function render(selection: Selection | null, hour: number): void {
    if (!selection) {
      showProblem('Choose a place to see what it will feel like.');
      return;
    }
    const cell = bundle.cells.get(selection.cellId);
    const validTime = bundle.manifest.forecast_times[hour];
    if (!cell || !validTime) {
      showProblem('This hour is missing from the forecast we have.');
      return;
    }

    section?.setAttribute('aria-busy', 'false');
    const apparent = cell.apparent_temperature_f[hour] ?? null;
    const air = cell.temperature_f[hour] ?? null;
    const high = peak(cell.apparent_temperature_f);
    const highTime = high ? bundle.manifest.forecast_times[high.index] : undefined;

    // Apparent and air temperature agree often in mild LA weather, by definition rather
    // than by accident, so showing the same number twice would read as a bug.
    const same = whole(apparent) !== null && whole(apparent) === whole(air);
    const secondary =
      apparent === null
        ? '<p class="card-secondary">We have no reading for this hour.</p>'
        : same
          ? '<p class="card-secondary">Same as the air temperature at this hour.</p>'
          : `<p class="card-secondary">Air temperature <strong>${degrees(air)}</strong></p>`;

    root.innerHTML = `
      <p class="card-place" id="card-place">${escape(selection.label)}</p>
      <p class="card-hour">${escape(hourLabel(validTime))}</p>
      <p class="card-value">
        <span class="card-number">${degrees(apparent)}</span>
        <span class="card-unit">feels like</span>
      </p>
      ${secondary}
      ${
        high && highTime
          ? `<p class="card-peak">Peaks at <strong>${degrees(high.value)}</strong> around ${escape(
              hourLabel(highTime),
            )}, in the next 24 hours.</p>`
          : '<p class="card-peak">No peak to report: this place has no values in the window.</p>'
      }
      ${selection.exact ? '<p class="card-note">Using your exact location. The name is the neighborhood it falls in.</p>' : ''}
      ${selection.note ? `<p class="card-note">${escape(selection.note)}</p>` : ''}
      ${
        apparent === null
          ? '<p class="card-note">The forecast grid has no value here for this hour. We leave it blank rather than guess.</p>'
          : ''
      }
    `;
  }

  return { render, showLoading, showProblem };
}

export function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}
