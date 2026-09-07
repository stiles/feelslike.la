// The masthead reading: place, hour, the big number, and where that number sits in the
// county's own range right now. This is the one thing on the page that used to be a
// sentence of prose (`writeHeroSummary`) plus a floating card glued to the map
// (`card.ts`). Merging them here means one authoritative reading instead of two numbers
// that happen to agree, and it frees the map to be just the map.

import { tweenDegrees } from './animate';
import { degrees, escape, hourLabel, peak, whole } from './format';
import type { Bundle, Selection } from './types';

export interface HeroView {
  render(selection: Selection | null, hour: number): void;
}

interface SpreadEntry {
  name: string;
  value: number;
  cellId: string;
}

export function createHero(root: HTMLElement, bundle: Bundle): HeroView {
  root.innerHTML = `
    <div class="hero-reading" id="hero-reading">
      <p class="hero-place" id="hero-place"></p>
      <p class="hero-hour" id="hero-hour"></p>
      <div class="hero-value">
        <span class="hero-number" id="hero-number">—</span>
        <span class="hero-unit">feels like</span>
      </div>
      <p class="hero-secondary" id="hero-secondary"></p>
      <div class="hero-notes" id="hero-notes"></div>
    </div>
    <div class="hero-problem" id="hero-problem" hidden>
      <p class="hero-problem-place">No forecast</p>
      <p class="hero-problem-text" id="hero-problem-text"></p>
    </div>
    <div class="spread" id="spread">
      <div class="spread-track" id="spread-track">
        <span class="spread-marker cool" id="spread-cool"
          ><span class="spread-dot"></span><span class="spread-label"></span
        ></span>
        <span class="spread-marker hot" id="spread-hot"
          ><span class="spread-dot"></span><span class="spread-label"></span
        ></span>
        <span class="spread-marker selected" id="spread-selected" hidden
          ><span class="spread-dot"></span><span class="spread-label"></span
        ></span>
      </div>
      <p class="spread-caption" id="spread-caption"></p>
    </div>
  `;

  const reading = root.querySelector('#hero-reading') as HTMLElement;
  const problem = root.querySelector('#hero-problem') as HTMLElement;
  const problemText = root.querySelector('#hero-problem-text') as HTMLElement;
  const place = root.querySelector('#hero-place') as HTMLElement;
  const hour = root.querySelector('#hero-hour') as HTMLElement;
  const number = root.querySelector('#hero-number') as HTMLElement;
  const secondary = root.querySelector('#hero-secondary') as HTMLElement;
  const notes = root.querySelector('#hero-notes') as HTMLElement;

  const track = root.querySelector('#spread-track') as HTMLElement;
  const caption = root.querySelector('#spread-caption') as HTMLElement;
  const coolMarker = root.querySelector('#spread-cool') as HTMLElement;
  const hotMarker = root.querySelector('#spread-hot') as HTMLElement;
  const selectedMarker = root.querySelector('#spread-selected') as HTMLElement;

  const domain = spreadDomain(bundle);
  track.style.backgroundImage = trackGradient(bundle, domain);

  function showProblem(message: string): void {
    reading.hidden = true;
    problem.hidden = false;
    problemText.textContent = message;
  }

  function render(selection: Selection | null, hourIndex: number): void {
    renderSpread(selection, hourIndex);

    if (!selection) {
      showProblem('Choose a place to see what it feels like right now.');
      return;
    }
    const cell = bundle.cells.get(selection.cellId);
    const validTime = bundle.manifest.forecast_times[hourIndex];
    if (!cell || !validTime) {
      showProblem('This hour is missing from the forecast we have.');
      return;
    }

    problem.hidden = true;
    reading.hidden = false;

    const apparent = cell.apparent_temperature_f[hourIndex] ?? null;
    const air = cell.temperature_f[hourIndex] ?? null;
    const high = peak(cell.apparent_temperature_f);
    const highTime = high ? bundle.manifest.forecast_times[high.index] : undefined;

    place.textContent = selection.label;
    hour.textContent = hourLabel(validTime);
    tweenDegrees(number, apparent);

    const same = whole(apparent) !== null && whole(apparent) === whole(air);
    secondary.innerHTML =
      apparent === null
        ? 'We have no reading for this hour.'
        : same
          ? 'Same as the air temperature at this hour.'
          : `Air temperature <strong>${degrees(air)}</strong>`;

    const lines: string[] = [];
    if (high && highTime) {
      lines.push(
        `Peaks at <strong>${degrees(high.value)}</strong> around ${escape(hourLabel(highTime))}, in the next 24 hours.`,
      );
    }
    if (selection.exact) {
      lines.push('Using your exact location. The name is the neighborhood it falls in.');
    }
    if (selection.note) lines.push(escape(selection.note));
    if (apparent === null) {
      lines.push('The forecast grid has no value here for this hour. We leave it blank rather than guess.');
    }
    notes.innerHTML = lines.map((line) => `<p class="hero-note">${line}</p>`).join('');
  }

  function renderSpread(selection: Selection | null, hourIndex: number): void {
    const spread = placeSpread(bundle, hourIndex);
    if (!spread) {
      caption.textContent = '';
      coolMarker.hidden = true;
      hotMarker.hidden = true;
      selectedMarker.hidden = true;
      return;
    }
    const { cool, hot } = spread;
    place2(coolMarker, cool, domain);
    place2(hotMarker, hot, domain);

    const selectedValue = selection ? bundle.cells.get(selection.cellId)?.apparent_temperature_f[hourIndex] ?? null : null;
    const isCoolOrHot =
      selection && (selection.cellId === cool.cellId || selection.cellId === hot.cellId);
    if (selection && selectedValue !== null && !isCoolOrHot) {
      selectedMarker.hidden = false;
      place2(selectedMarker, { name: selection.label, value: selectedValue, cellId: selection.cellId }, domain);
    } else {
      selectedMarker.hidden = true;
    }

    const gap = Math.max(0, Math.round(hot.value) - Math.round(cool.value));
    caption.innerHTML = `<strong>${gap}&deg;</strong> across LA County this hour &mdash; ${escape(
      cool.name,
    )} at ${degrees(cool.value)}, ${escape(hot.name)} at ${degrees(hot.value)}.`;
  }

  return { render };
}

function place2(marker: HTMLElement, entry: SpreadEntry, domain: [number, number]): void {
  const [low, high] = domain;
  const pct = clamp(((entry.value - low) / (high - low)) * 100, 2, 98);
  marker.style.left = `${pct}%`;
  const label = marker.querySelector('.spread-label') as HTMLElement;
  label.textContent = `${entry.name} ${degrees(entry.value)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function placeSpread(bundle: Bundle, hourIndex: number): { cool: SpreadEntry; hot: SpreadEntry } | null {
  let cool: SpreadEntry | null = null;
  let hot: SpreadEntry | null = null;

  for (const item of bundle.ordered) {
    const cellId = bundle.placeCells.places[item.slug]?.cell_id;
    const value = cellId ? bundle.cells.get(cellId)?.apparent_temperature_f[hourIndex] ?? null : null;
    if (value === null || !cellId) continue;
    if (!cool || value < cool.value) cool = { name: item.name, value, cellId };
    if (!hot || value > hot.value) hot = { name: item.name, value, cellId };
  }

  return cool && hot ? { cool, hot } : null;
}

/** A fixed-ish domain, padded from the published band breaks so the bar reads the same
 * shape build to build rather than rescaling with the day's own spread. */
function spreadDomain(bundle: Bundle): [number, number] {
  const breaks = bundle.manifest.band_breaks_f;
  const low = (breaks[0] ?? 50) - 8;
  const high = (breaks[breaks.length - 1] ?? 110) + 8;
  return [low, high];
}

/** Hard-edged color stops, echoing the map legend rather than smoothing between classes
 * that are, on the map, sharp boundaries. */
function trackGradient(bundle: Bundle, domain: [number, number]): string {
  const [low, high] = domain;
  const span = high - low;
  const stops: string[] = [];
  for (const band of bundle.manifest.display.bands) {
    const lower = band.lower_f ?? low;
    const upper = band.upper_f ?? high;
    const start = clamp(((lower - low) / span) * 100, 0, 100);
    const end = clamp(((upper - low) / span) * 100, 0, 100);
    if (end <= start) continue;
    stops.push(`${band.color} ${start}%`, `${band.color} ${end}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
