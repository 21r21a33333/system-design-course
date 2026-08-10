import { describe, expect, it, beforeEach } from 'vitest';
import { computeCompletionPercent } from './progress';

describe('computeCompletionPercent', () => {
  it('returns 0 for an empty id list', () => {
    expect(computeCompletionPercent([], {})).toBe(0);
  });

  it('returns the rounded percentage of completed ids', () => {
    expect(computeCompletionPercent(['a', 'b', 'c'], { a: true, b: true })).toBe(67);
  });

  it('ignores completed ids not present in the given id list', () => {
    expect(computeCompletionPercent(['a'], { a: true, z: true })).toBe(100);
  });
});
