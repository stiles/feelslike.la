// One comparison place, read at the same valid time as the card.
//
// Before a second place is chosen: a search and a few suggestions, not a paragraph of
// instructions. After: the result itself — name, temperature, a plain-language
// difference — is the content, not a caption describing what the reader is about to see.

import { degrees, difference, endSentence, escape, weekdayHour } from './format';
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
  const resultRoot = document.createElement('div');
  resultRoot.className = 'compare-result';
  resultRoot.setAttribute('role', 'status');
  root.replaceChildren(pickerRoot, suggestionRoot, resultRoot);

  const picker = createPicker(pickerRoot, {
    id: 'compare-place',
    label: 'Second place',
    placeholder: 'Santa Monica, Lancaster…',
    places: bundle.ordered,
    onSelect: (slug) => onChange(slug),
    onClear: () => onChange(null),
    clearLabel: 'Remove',
  });

  suggestionRoot.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('.suggestion') as HTMLElement | null;
    if (button?.dataset.slug) onChange(button.dataset.slug);
  });

  function render(selection: Selection | null, hour: number, comparison: string | null): void {
    const name = comparison ? bundle.places.get(comparison)?.name ?? '' : '';
    picker.setValue(name);
    // Once a comparison is active, the result card below is the one place to change or
    // remove it — showing the search box too would be a second, redundant "Remove."
    pickerRoot.hidden = Boolean(comparison);

    if (!comparison) {
      // Suggestions never include the place already on screen — comparing it with
      // itself has nothing to say, so it is left off rather than shown disabled.
      const options = SUGGESTIONS.filter(
        (slug) => bundle.places.has(slug) && slug !== selection?.slug,
      ).slice(0, 3);
      suggestionRoot.hidden = options.length === 0;
      suggestionRoot.innerHTML = options
        .map(
          (slug) =>
            `<button type="button" class="suggestion" data-slug="${escape(slug)}">${escape(
              bundle.places.get(slug)?.name ?? slug,
            )}</button>`,
        )
        .join('');
      resultRoot.hidden = true;
      resultRoot.innerHTML = '';
      return;
    }

    suggestionRoot.hidden = true;

    if (!selection) {
      resultRoot.hidden = true;
      return;
    }

    const validTime = bundle.manifest.forecast_times[hour];
    const mine = bundle.cells.get(selection.cellId)?.apparent_temperature_f[hour] ?? null;
    const theirCell = bundle.placeCells.places[comparison]?.cell_id;
    const theirs = theirCell ? bundle.cells.get(theirCell)?.apparent_temperature_f[hour] ?? null : null;

    resultRoot.hidden = false;

    if (!theirCell) {
      resultRoot.innerHTML = `<p class="compare-problem">${escape(name)} sits outside the forecast area.</p>${removeButton()}`;
      wireRemove();
      return;
    }
    if (mine === null || theirs === null || !validTime) {
      resultRoot.innerHTML = `<p class="compare-problem">No comparison for this hour: one of the two has no value.</p>${removeButton()}`;
      wireRemove();
      return;
    }

    // Same cell means the same forecast, which is a real answer rather than a failure.
    if (theirCell === selection.cellId) {
      resultRoot.innerHTML = `
        <div class="compare-result-place">
          <p class="compare-result-name">${escape(name)}</p>
          <p class="compare-result-temp">${degrees(mine)}</p>
        </div>
        <p class="compare-result-diff">${endSentence(`Same forecast cell as ${escape(selection.label)}, at ${escape(weekdayHour(validTime))}`)}</p>
        ${removeButton()}
      `;
      wireRemove();
      return;
    }

    const gap = difference(mine, theirs);
    if (!gap) {
      resultRoot.hidden = true;
      return;
    }
    const when = escape(weekdayHour(validTime));
    const diffText =
      gap.word === 'the same'
        ? endSentence(`About the same as ${escape(selection.label)} at ${when}`)
        : `<strong>${gap.degrees}° ${gap.word}</strong> ${endSentence(`than ${escape(selection.label)} at ${when}`)}`;

    resultRoot.innerHTML = `
      <div class="compare-result-place">
        <p class="compare-result-name">${escape(name)}</p>
        <p class="compare-result-temp">${degrees(theirs)}</p>
      </div>
      <p class="compare-result-diff">${diffText}</p>
      ${removeButton()}
    `;
    wireRemove();
  }

  function removeButton(): string {
    return `<button type="button" class="compare-remove" id="compare-remove">Remove</button>`;
  }

  function wireRemove(): void {
    resultRoot.querySelector('#compare-remove')?.addEventListener('click', () => onChange(null));
  }

  return { render };
}
