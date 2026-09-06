// Application state: one place, one hour, one optional comparison.
//
// Every view reads the same `hour`, which is what keeps the card, the chart cursor, the
// map frame and the comparison on the same valid time.

import type { Selection } from './types';

export interface State {
  selection: Selection | null;
  hour: number;
  comparison: string | null;
  /** Set when a request could not be honored, for the reader to read and recover from. */
  problem: string | null;
}

type Listener = (state: State) => void;

export class Store {
  private state: State = { selection: null, hour: 0, comparison: null, problem: null };
  private readonly listeners = new Set<Listener>();

  get current(): State {
    return this.state;
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
  }

  update(patch: Partial<State>): void {
    const next = { ...this.state, ...patch };
    if (
      next.selection === this.state.selection &&
      next.hour === this.state.hour &&
      next.comparison === this.state.comparison &&
      next.problem === this.state.problem
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener(this.state);
  }
}

const STORAGE_KEY = 'feelslike.la:place';

export function rememberPlace(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(STORAGE_KEY, slug);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing and blocked storage are not errors worth showing anyone.
  }
}

export function rememberedPlace(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The place in the URL, from either a path or a query parameter.
 *
 * `/del-rey` is the canonical shareable form. `?place=del-rey` is accepted too, so the
 * app still works on a host that cannot rewrite unknown paths to index.html.
 */
export function placeFromUrl(base = import.meta.env.BASE_URL): string | null {
  const url = new URL(window.location.href);
  const query = url.searchParams.get('place');
  if (query) return slugify(query);

  const prefix = base.replace(/\/$/, '');
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  const first = path.split('/').filter(Boolean)[0];
  return first ? slugify(decodeURIComponent(first)) : null;
}

export function comparisonFromUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get('compare');
  return value ? slugify(value) : null;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Write the selection into the URL.
 *
 * A geolocated coordinate is deliberately not written: a shared link should not carry
 * where someone was standing. Such a selection leaves the URL at the root.
 */
export function writeUrl(state: State, base = import.meta.env.BASE_URL): void {
  const prefix = base.replace(/\/$/, '');
  const slug = state.selection && !state.selection.exact ? state.selection.slug : null;
  const query = state.comparison ? `?compare=${state.comparison}` : '';
  const next = `${prefix}/${slug ?? ''}${query}`;
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState(null, '', next);
  }
}
