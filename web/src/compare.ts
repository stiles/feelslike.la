// One comparison place, read at the same valid time as the card.

import { degrees, difference, escape, hourLabel } from './format';
import { createPicker } from './picker';
import type { Bundle, Selection } from './types';

const SUGGESTIONS = ['santa-monica', 'downtown', 'woodland-hills', 'lancaster'];

export interface CompareView {
  render(selection: Selection | null, hour: number, comparison: string | null): void;
}

export function createCompare(
  root: HTMLElement,
  bundle: Bundle,
  onChange: (slug: string | null) => void,
): CompareView {
  const pickerRoot = document.createElement('div');
  const suggestionRoot = document.createElement('div');
  suggestionRoot.className = 'suggestions';
  const readout = document.createElement('p');
  readout.className = 'compare-readout';
  readout.setAttribute('role', 'status');
  root.replaceChildren(pickerRoot, suggestionRoot, readout);

  const picker = createPicker(pickerRoot, {
    id: 'compare-place',
    label: 'Second place',
    placeholder: 'Santa Monica, Lancaster…',
    places: bundle.ordered,
    onSelect: (slug) => onChange(slug),
    onClear: () => onChange(null),
    clearLabel: 'Remove',
  });

  suggestionRoot.innerHTML = SUGGESTIONS.filter((slug) => bundle.places.has(slug))
    .map(
      (slug) =>
        `<button type="button" class="suggestion" data-slug="${escape(slug)}">${escape(
          bundle.places.get(slug)?.name ?? slug,
        )}</button>`,
    )
    .join('');

  suggestionRoot.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('.suggestion') as HTMLElement | null;
    if (button?.dataset.slug) onChange(button.dataset.slug);
  });

  function render(selection: Selection | null, hour: number, comparison: string | null): void {
    const name = comparison ? bundle.places.get(comparison)?.name ?? '' : '';
    picker.setValue(name);

    for (const button of suggestionRoot.querySelectorAll('.suggestion')) {
      const slug = (button as HTMLElement).dataset.slug;
      button.classList.toggle('active', slug === comparison);
      button.setAttribute('aria-pressed', String(slug === comparison));
      // Comparing a place with itself has nothing to say.
      (button as HTMLButtonElement).disabled = Boolean(selection?.slug && slug === selection.slug);
    }

    if (!selection || !comparison) {
      readout.textContent = selection
        ? 'Pick a second place to see the difference at this hour.'
        : '';
      return;
    }

    const validTime = bundle.manifest.forecast_times[hour];
    const mine = bundle.cells.get(selection.cellId)?.apparent_temperature_f[hour] ?? null;
    const theirCell = bundle.placeCells.places[comparison]?.cell_id;
    const theirs = theirCell
      ? bundle.cells.get(theirCell)?.apparent_temperature_f[hour] ?? null
      : null;

    if (!theirCell) {
      readout.innerHTML = `<span class="compare-problem">${escape(
        name,
      )} sits outside the forecast area.</span>`;
      return;
    }
    if (mine === null || theirs === null || !validTime) {
      readout.innerHTML = `<span class="compare-problem">No comparison for this hour: one of the two has no value.</span>`;
      return;
    }

    // Same cell means the same forecast, which is a real answer rather than a failure.
    if (theirCell === selection.cellId) {
      readout.innerHTML = `${escape(name)} and ${escape(
        selection.label,
      )} fall in the same forecast cell, so they share a value: <strong>${degrees(mine)}</strong>.`;
      return;
    }

    const gap = difference(mine, theirs);
    if (!gap) return;
    readout.innerHTML =
      gap.word === 'the same'
        ? `At ${escape(hourLabel(validTime))}, ${escape(selection.label)} and ${escape(
            name,
          )} both feel like <strong>${degrees(mine)}</strong>.`
        : `At ${escape(hourLabel(validTime))}, ${escape(selection.label)} feels
           <strong>${gap.degrees}° ${gap.word}</strong> than ${escape(name)}:
           <strong>${degrees(mine)}</strong> against ${degrees(theirs)}.`;
  }

  return { render };
}
