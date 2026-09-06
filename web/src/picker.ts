// A keyboard-operable place picker, used for both the main search and the comparison.
//
// Follows the ARIA combobox pattern: the input keeps focus, arrow keys move
// `aria-activedescendant` through the listbox, Enter commits and Escape closes.

import { escape } from './card';
import type { Place } from './types';

export interface Picker {
  setValue(label: string): void;
  focus(): void;
}

interface Options {
  id: string;
  label: string;
  placeholder: string;
  places: Place[];
  onSelect: (slug: string) => void;
  onClear?: () => void;
  clearLabel?: string;
}

export function createPicker(root: HTMLElement, options: Options): Picker {
  const listId = `${options.id}-list`;
  root.innerHTML = `
    <label class="picker-label" for="${options.id}">${escape(options.label)}</label>
    <div class="picker-shell">
      <input
        type="text"
        id="${options.id}"
        class="picker-input"
        role="combobox"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        aria-expanded="false"
        aria-controls="${listId}"
        aria-autocomplete="list"
        placeholder="${escape(options.placeholder)}"
      />
      ${
        options.onClear
          ? `<button type="button" class="picker-clear" hidden>${escape(options.clearLabel ?? 'Clear')}</button>`
          : ''
      }
    </div>
    <ul class="picker-list" id="${listId}" role="listbox" hidden></ul>
    <p class="picker-status visually-hidden" role="status"></p>
  `;

  const input = root.querySelector(`#${options.id}`) as HTMLInputElement;
  const list = root.querySelector(`#${listId}`) as HTMLUListElement;
  const status = root.querySelector('.picker-status') as HTMLElement;
  const clear = root.querySelector('.picker-clear') as HTMLButtonElement | null;

  let matches: Place[] = [];
  let active = -1;

  function close(): void {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function open(query: string): void {
    matches = search(options.places, query);
    if (!matches.length) {
      list.hidden = false;
      list.innerHTML = `<li class="picker-empty">No place matches “${escape(query)}”</li>`;
      input.setAttribute('aria-expanded', 'true');
      status.textContent = 'No matches';
      return;
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.innerHTML = matches
      .map(
        (place, index) => `
        <li
          role="option"
          id="${options.id}-option-${index}"
          class="picker-option"
          aria-selected="${index === active}"
          data-slug="${escape(place.slug)}"
        >
          <span class="picker-name">${escape(place.name)}</span>
          <span class="picker-meta">${escape(describe(place))}</span>
        </li>`,
      )
      .join('');
    status.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
  }

  function highlight(next: number): void {
    if (!matches.length) return;
    active = (next + matches.length) % matches.length;
    for (const [index, node] of [...list.children].entries()) {
      node.setAttribute('aria-selected', String(index === active));
    }
    const chosen = list.children[active] as HTMLElement | undefined;
    if (chosen) {
      input.setAttribute('aria-activedescendant', chosen.id);
      chosen.scrollIntoView({ block: 'nearest' });
    }
  }

  function commit(place: Place | undefined): void {
    if (!place) return;
    input.value = place.name;
    close();
    options.onSelect(place.slug);
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    if (query.length < 1) close();
    else open(query);
    if (clear) clear.hidden = !input.value;
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (list.hidden) open(input.value.trim() || '');
      else highlight(active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active - 1);
    } else if (event.key === 'Enter') {
      if (!list.hidden) {
        event.preventDefault();
        commit(matches[active >= 0 ? active : 0]);
      }
    } else if (event.key === 'Escape') {
      close();
    }
  });

  list.addEventListener('mousedown', (event) => {
    const option = (event.target as HTMLElement).closest('.picker-option') as HTMLElement | null;
    if (!option) return;
    event.preventDefault();
    commit(options.places.find((place) => place.slug === option.dataset.slug));
  });

  input.addEventListener('blur', () => {
    // Deferred so a click on an option lands before the list disappears.
    window.setTimeout(close, 120);
  });

  clear?.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    close();
    options.onClear?.();
  });

  return {
    setValue(label: string) {
      input.value = label;
      if (clear) clear.hidden = !label;
    },
    focus() {
      input.focus();
    },
  };
}

function describe(place: Place): string {
  const region = place.region.replace(/-/g, ' ');
  if (place.source_type === 'standalone-city') return `City · ${region}`;
  if (place.source_type === 'unincorporated-area') return `Unincorporated · ${region}`;
  if (place.city === 'los-angeles') return `Los Angeles · ${region}`;
  return region;
}

/**
 * Prefix matches first, then word starts, then anything containing the query.
 *
 * Typing "san" should reach San Pedro before Sepulveda Basin, which a plain substring
 * sort does not do.
 */
export function search(places: Place[], query: string, limit = 8): Place[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return places.slice(0, limit);

  const scored: { place: Place; score: number }[] = [];
  for (const place of places) {
    const name = place.name.toLowerCase();
    const haystack = [name, place.slug, ...place.aliases.map((alias) => alias.toLowerCase())];
    let score = Number.POSITIVE_INFINITY;
    for (const candidate of haystack) {
      if (candidate.startsWith(needle)) score = Math.min(score, 0);
      else if (new RegExp(`\\b${escapeRegExp(needle)}`).test(candidate)) score = Math.min(score, 1);
      else if (candidate.includes(needle)) score = Math.min(score, 2);
    }
    if (Number.isFinite(score)) scored.push({ place, score });
  }

  scored.sort((a, b) => a.score - b.score || a.place.name.localeCompare(b.place.name));
  return scored.slice(0, limit).map((entry) => entry.place);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
