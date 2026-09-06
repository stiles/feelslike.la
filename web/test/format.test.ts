// Formatting, comparison and freshness. Each of these can publish a wrong number
// while looking completely normal.

import { describe, expect, it } from 'vitest';

import { axisHour, degrees, difference, freshness, hourLabel, localHour, peak } from '../src/format';
import type { Manifest } from '../src/types';

describe('displayed values', () => {
  it('rounds to whole degrees', () => {
    expect(degrees(72.4)).toBe('72°');
    expect(degrees(72.5)).toBe('73°');
  });

  it('shows a missing value as a dash rather than a zero', () => {
    expect(degrees(null)).toBe('—');
  });
});

describe('comparison', () => {
  it('agrees with the numbers on screen', () => {
    // 71.4 and 70.6 differ by less than a degree but display as 71 and 71, so the card
    // must not claim a difference it is not showing.
    expect(degrees(71.4)).toBe(degrees(70.6));
    expect(difference(71.4, 70.6)).toEqual({ word: 'the same', degrees: 0 });
  });

  it('names the direction from the selected place', () => {
    expect(difference(88, 74)).toEqual({ word: 'warmer', degrees: 14 });
    expect(difference(74, 88)).toEqual({ word: 'cooler', degrees: 14 });
  });

  it('has nothing to say when either value is missing', () => {
    expect(difference(74, null)).toBeNull();
    expect(difference(null, 74)).toBeNull();
  });
});

describe('peak', () => {
  it('comes from unrounded values', () => {
    const found = peak([70.2, 88.49, 88.51, null, 71]);
    expect(found).toEqual({ index: 2, value: 88.51 });
  });

  it('skips nulls without treating them as zero', () => {
    expect(peak([null, null, 61.1])).toEqual({ index: 2, value: 61.1 });
    expect(peak([null, null])).toBeNull();
  });
});

describe('local hour labels', () => {
  it('distinguishes the repeated hour when the clocks go back', () => {
    // Two distinct instants that are both 1 a.m. in Los Angeles. Without the zone
    // abbreviation these labels would be identical and the slider would appear to
    // repeat an hour.
    expect(hourLabel('2026-11-01T08:00:00Z')).toBe('Sun 1 a.m. PDT');
    expect(hourLabel('2026-11-01T09:00:00Z')).toBe('Sun 1 a.m. PST');
  });

  it('uses AP style for the hour', () => {
    expect(hourLabel('2026-09-06T21:00:00Z')).toBe('Sun 2 p.m. PDT');
    expect(axisHour('2026-09-06T21:00:00Z')).toBe('2 p.m.');
  });

  it('reads midnight as hour zero, so the chart can rule off a new day', () => {
    expect(localHour('2026-09-07T07:00:00Z')).toBe(0);
  });
});

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  const now = Date.parse('2026-09-06T21:00:00Z');
  return {
    retrieved_at: new Date(now - 5 * 60000).toISOString(),
    forecast_reference_times: [new Date(now + 30 * 60000).toISOString()],
    forecast_times: [new Date(now + 60 * 60000).toISOString()],
    ...overrides,
  } as Manifest;
}

describe('freshness', () => {
  const now = new Date('2026-09-06T21:00:00Z');

  it('does not report a negative source age', () => {
    // NDFD stamps a run for the half hour after it posts, so a fresh cycle can carry a
    // reference time in the future.
    const state = freshness(manifest(), now);
    expect(state.state).toBe('current');
    expect(state.message).not.toContain('-');
  });

  it('warns when no refresh has succeeded for three hours', () => {
    const state = freshness(
      manifest({ retrieved_at: '2026-09-06T17:30:00Z' }),
      now,
    );
    expect(state.state).toBe('stale');
  });

  it('flags old source data separately from a recent download', () => {
    const state = freshness(
      manifest({ forecast_reference_times: ['2026-09-06T14:00:00Z'] }),
      now,
    );
    expect(state.state).toBe('aging');
    expect(state.message).toContain('7 hours');
  });

  it('drops the forecast claim when every hour is in the past', () => {
    const state = freshness(
      manifest({ forecast_times: ['2026-09-06T19:00:00Z', '2026-09-06T20:00:00Z'] }),
      now,
    );
    expect(state.state).toBe('expired');
  });
});
