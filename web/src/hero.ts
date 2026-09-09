// The summary panel: where the reader changes place, and the answer to "what will it
// feel like." Search lives here rather than in a separate section, because changing the
// subject of the big number is the most common thing a reader does on this page and
// should never require scrolling past it.

import { tweenDegrees } from './animate';
import { degrees, endSentence, escape, peakLabel, weekdayHourLong, whole } from './format';
import type { Bundle, Selection } from './types';

export interface HeroView {
  render(selection: Selection | null, hour: number): void;
}

/**
 * The map's own band color for a temperature, not a separate scale — same breaks
 * (`band_breaks_f`) and palette (`display.bands`) the fill layer and legend already use,
 * so a color here always means what it means everywhere else on the page.
 */
function bandColor(bundle: Bundle, value: number | null): string | null {
  if (value === null) return null;
  const breaks = bundle.manifest.band_breaks_f;
  let index = 0;
  for (const brk of breaks) {
    if (value < brk) break;
    index += 1;
  }
  return bundle.manifest.display.bands[index]?.color ?? null;
}

export function createHero(root: HTMLElement, bundle: Bundle): HeroView {
  root.innerHTML = `
    <div class="finder">
      <div id="search"></div>
      <button class="locate" id="locate" type="button">
        <span class="locate-icon" aria-hidden="true"></span>
        <span class="locate-label">My location</span>
      </button>
    </div>
    <p class="locate-status" id="locate-status" role="status"></p>

    <div class="hero-reading" id="hero-reading">
      <p class="place-name" id="hero-place"></p>
      <p class="hero-hour" id="hero-hour"></p>
      <div class="hero-value">
        <p class="hero-label">Feels like forecast</p>
        <p class="hero-number" id="hero-number">—</p>
      </div>
      <p class="hero-secondary" id="hero-secondary"></p>
      <div class="hero-peak" id="hero-peak">
        <p class="hero-peak-label">Next 24 hours</p>
        <p class="hero-peak-text" id="hero-peak-text"></p>
      </div>
      <div class="hero-notes" id="hero-notes"></div>
    </div>
    <div class="hero-problem" id="hero-problem" hidden>
      <p class="place-name">No forecast</p>
      <p class="hero-problem-text" id="hero-problem-text"></p>
    </div>
  `;

  const reading = root.querySelector('#hero-reading') as HTMLElement;
  const problem = root.querySelector('#hero-problem') as HTMLElement;
  const problemText = root.querySelector('#hero-problem-text') as HTMLElement;
  const place = root.querySelector('#hero-place') as HTMLElement;
  const hour = root.querySelector('#hero-hour') as HTMLElement;
  const number = root.querySelector('#hero-number') as HTMLElement;
  const secondary = root.querySelector('#hero-secondary') as HTMLElement;
  const peakText = root.querySelector('#hero-peak-text') as HTMLElement;
  const peakBlock = root.querySelector('#hero-peak') as HTMLElement;
  const notes = root.querySelector('#hero-notes') as HTMLElement;

  function showProblem(message: string): void {
    reading.hidden = true;
    problem.hidden = false;
    problemText.textContent = message;
    root.style.setProperty('--band-color', 'transparent');
  }

  function render(selection: Selection | null, hourIndex: number): void {
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
    const high = peakLabel(cell.apparent_temperature_f, bundle.manifest.forecast_times, hourIndex);

    place.textContent = selection.label;
    // The zone abbreviation appears once, near the timeline (see #timeline-panel), not
    // on every line that mentions a time.
    hour.textContent = weekdayHourLong(validTime);
    tweenDegrees(number, apparent);
    // A soft wash of the map's own band color behind the number — see .summary-panel's
    // background in styles.css — rather than recoloring the panel itself, which would
    // put its legibility at the mercy of whichever of 14 colors happens to be current.
    root.style.setProperty('--band-color', bandColor(bundle, apparent) ?? 'transparent');

    const same = whole(apparent) !== null && whole(apparent) === whole(air);
    secondary.innerHTML =
      apparent === null
        ? 'We have no reading for this hour.'
        : same
          ? 'Same as the air temperature at this hour.'
          : `Air temperature: <strong>${degrees(air)}</strong>`;

    if (high) {
      peakBlock.hidden = false;
      peakText.innerHTML = `Peak feels like <strong>${degrees(high.value)}</strong> ${endSentence(escape(high.when))}`;
    } else {
      peakBlock.hidden = true;
    }

    const lines: string[] = [];
    if (selection.exact) {
      lines.push('Using your exact location. The name is the neighborhood it falls in.');
    }
    if (selection.note) lines.push(escape(selection.note));
    if (apparent === null) {
      lines.push('The forecast grid has no value here for this hour. We leave it blank rather than guess.');
    }
    notes.innerHTML = lines.map((line) => `<p class="hero-note">${line}</p>`).join('');
  }

  return { render };
}
