import { describe, expect, it } from 'vitest';

import type { RetractionStatusResponse } from './index';

describe('types package', () => {
  it('exports RetractionStatusResponse shape', () => {
    const sample: RetractionStatusResponse = {
      doi: '10.1000/xyz',
      meta: {},
      records: [],
    };
    expect(sample.doi).toBe('10.1000/xyz');
  });
});

