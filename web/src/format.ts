// Display formatting. One place decides how a number, an hour and a comparison read.

import type { Manifest } from './types';

const ZONE = 'America/Los_Angeles';

/**
 * Whole degrees for display, rounded from the stored value.
 *
 * Rounding happens once, here, and every comparison uses these rounded values so the
 * card can never say two places differ while showing them the same number.
 */
export function degrees(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}°`;
}

export function whole(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

const partFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short',
  hour: 'numeric',
  timeZoneName: 'short',
});

/**
 * "Sun 2 p.m. PDT", assembled from parts rather than formatted directly.
 *
 * Intl gives "Sun, 2 PM PDT"; AP style wants no comma and "p.m." So the parts get
 * reassembled instead of patched with string replacements.
 *
 * The zone abbreviation is always shown. It is how a reader tells the two 1 a.m. hours
 * apart on the night the clocks change, and the only cue that these are local times.
 */
export function hourLabel(iso: string): string {
  const parts = new Map(
    partFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const period = (parts.get('dayPeriod') ?? '').toLowerCase() === 'am' ? 'a.m.' : 'p.m.';
  return `${parts.get('weekday')} ${parts.get('hour')} ${period} ${parts.get('timeZoneName')}`;
}

/**
 * "Mon 6 p.m.", with no zone abbreviation.
 *
 * Every hour mentioned on the page after the first is this, not `hourLabel`. Saying
 * "PDT" once, near the time controls, and never again is more legible than stamping it
 * onto every sentence that names an hour — see the zone note beside #slider.
 */
export function weekdayHour(iso: string): string {
  const parts = new Map(partFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  const period = (parts.get('dayPeriod') ?? '').toLowerCase() === 'am' ? 'a.m.' : 'p.m.';
  return `${parts.get('weekday')} ${parts.get('hour')} ${period}`;
}

const fullWeekdayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'long',
  hour: 'numeric',
});

/** "Tuesday at 2 p.m.", for the one-sentence peak summary. */
function weekdayHourFull(iso: string): string {
  const parts = new Map(
    fullWeekdayFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const period = (parts.get('dayPeriod') ?? '').toLowerCase() === 'am' ? 'a.m.' : 'p.m.';
  return `${parts.get('weekday')} at ${parts.get('hour')} ${period}`;
}

/** "2 p.m.", for the chart axis where the day is already established. */
export function axisHour(iso: string): string {
  const parts = new Map(
    partFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const period = (parts.get('dayPeriod') ?? '').toLowerCase() === 'am' ? 'a.m.' : 'p.m.';
  return `${parts.get('hour')} ${period}`;
}

const hour24Format = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour: 'numeric',
  hour12: false,
});

export function localHour(iso: string): number {
  // Intl renders midnight as 24 in some environments, so normalize it.
  return Number(hour24Format.format(new Date(iso))) % 24;
}

/** Peak over the published window, from unrounded values. */
export function peak(series: (number | null)[]): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  series.forEach((value, index) => {
    if (value !== null && (!best || value > best.value)) best = { index, value };
  });
  return best;
}

/**
 * The peak, phrased as one sentence's worth of "when": "Tuesday at 2 p.m.", or "right
 * now" for the edge case where the hour on screen already is the peak.
 */
export function peakLabel(
  series: (number | null)[],
  times: string[],
  currentIndex: number,
): { value: number; when: string } | null {
  const high = peak(series);
  const stamp = high ? times[high.index] : undefined;
  if (!high || !stamp) return null;
  return {
    value: high.value,
    when: high.index === currentIndex ? 'right now' : weekdayHourFull(stamp),
  };
}

const exactFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** "Mon, Sep 7, 6:00 PM PDT" — the exact stamp behind a relative "2 hours ago." */
export function exactTimestamp(iso: string): string {
  return exactFormat.format(new Date(iso));
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** "Tue, Sep 8" — the chart's day-transition label, which says what changed rather
 * than just that midnight happened. */
export function dateLabel(iso: string): string {
  return dateFormat.format(new Date(iso));
}

export type Difference = { word: 'warmer' | 'cooler' | 'the same'; degrees: number };

/**
 * Compare after rounding, so the words match the numbers on screen.
 *
 * Comparing unrounded values would let the card read "1° warmer" beside two identical
 * displayed temperatures.
 */
export function difference(mine: number | null, theirs: number | null): Difference | null {
  const a = whole(mine);
  const b = whole(theirs);
  if (a === null || b === null) return null;
  const gap = a - b;
  if (gap === 0) return { word: 'the same', degrees: 0 };
  return { word: gap > 0 ? 'warmer' : 'cooler', degrees: Math.abs(gap) };
}

export type Freshness = {
  state: 'current' | 'aging' | 'stale' | 'expired';
  message: string;
};

/**
 * How much to trust what is on screen.
 *
 * Source age and refresh age are separate facts: a build can be minutes old and carry a
 * forecast run from hours ago. The stronger of the two decides the state.
 *
 * NDFD stamps a run for the half hour after it posts, so source age is often slightly
 * negative on a fresh cycle. Clamping at zero keeps the display honest without inventing
 * a "-6 minutes old" reading.
 */
export function freshness(manifest: Manifest, now = new Date()): Freshness {
  const last = manifest.forecast_times[manifest.forecast_times.length - 1];
  if (last && new Date(last).getTime() <= now.getTime()) {
    return {
      state: 'expired',
      message: 'This forecast has run out. Every hour it covered is now in the past.',
    };
  }

  const refreshMinutes = minutesSince(manifest.retrieved_at, now);
  const references = manifest.forecast_reference_times.map((stamp) => minutesSince(stamp, now));
  const sourceMinutes = references.length ? Math.max(0, Math.min(...references)) : refreshMinutes;

  if (refreshMinutes >= 180) {
    return {
      state: 'stale',
      message: `Last updated ${describe(refreshMinutes)} ago. We may be having trouble reaching the weather service.`,
    };
  }
  if (sourceMinutes >= 180) {
    return {
      state: 'aging',
      message: `The National Weather Service run behind this forecast is ${describe(sourceMinutes)} old.`,
    };
  }
  return {
    state: 'current',
    message: `National Weather Service forecast issued ${describe(sourceMinutes)} ago.`,
  };
}

function minutesSince(stamp: string, now: Date): number {
  return Math.round((now.getTime() - new Date(stamp).getTime()) / 60000);
}

function describe(minutes: number): string {
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Appends a period unless the text already ends with one — "p.m." carries its own,
 * and a sentence built by concatenation must not double it into "p.m..". */
export function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

export function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}
