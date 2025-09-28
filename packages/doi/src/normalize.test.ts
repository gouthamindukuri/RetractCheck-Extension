import { describe, expect, it } from 'vitest';

import { cleanDoi, normaliseDoi } from './normalize';

describe('cleanDoi', () => {
  it('strips prefixes and normalises casing', () => {
    expect(cleanDoi('https://doi.org/10.1000/XYZ')).toBe('10.1000/xyz');
  });

  it('removes percent-encoded characters', () => {
    expect(cleanDoi('10.1000%2Ffoo%3ABar')).toBe('10.1000/foo:bar');
  });

  it('returns null for invalid values', () => {
    expect(cleanDoi('not-a-doi')).toBeNull();
    expect(cleanDoi(undefined)).toBeNull();
  });
});

describe('normaliseDoi', () => {
  it('delegates to cleanDoi', () => {
    expect(normaliseDoi('https://doi.org/10.1000/abc')).toBe('10.1000/abc');
  });
});

