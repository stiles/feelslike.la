// Search ranking and URL handling.

import { describe, expect, it } from 'vitest';

import { search } from '../src/picker';
import type { Place } from '../src/types';

function place(slug: string, name: string, aliases: string[] = []): Place {
  return {
    slug,
    name,
    region: 'westside',
    source_type: 'segment-of-a-city',
    city: 'los-angeles',
    area_sqmi: 1,
    reference_point: {
      longitude: -118.4,
      latitude: 34,
      method: 'polylabel_largest_part',
      reviewed: false,
      review_note: null,
    },
    aliases,
  };
}

const places = [
  place('sepulveda-basin', 'Sepulveda Basin'),
  place('san-pedro', 'San Pedro'),
  place('santa-monica', 'Santa Monica'),
  place('north-hollywood', 'North Hollywood', ['noho']),
  place('hollywood', 'Hollywood'),
  place('east-hollywood', 'East Hollywood'),
  place('downtown', 'Downtown'),
];

describe('search', () => {
  it('puts names that start with the query first, in alphabetical order', () => {
    expect(search(places, 'san').map((result) => result.slug)).toEqual([
      'san-pedro',
      'santa-monica',
    ]);
  });

  it('ranks a starting name above the same word inside another name', () => {
    // Typing "hollywood" should reach Hollywood before East and North Hollywood, which
    // alphabetical order alone would not do.
    expect(search(places, 'hollywood').map((result) => result.slug)).toEqual([
      'hollywood',
      'east-hollywood',
      'north-hollywood',
    ]);
  });

  it('matches an alias', () => {
    expect(search(places, 'noho')[0]?.slug).toBe('north-hollywood');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(search(places, 'brooklyn')).toEqual([]);
  });
});
