import { describe, expect, it } from 'vitest';
import { routingTierCriteria } from '../src/routing/policy.js';

const criteria = (names: string[]) => routingTierCriteria(names.map(name => ({ name })));
const capability = (description: string) => description.replace(/^Tier \d+ of \d+\. /, '');

describe('routing tier capabilities', () => {
  it.each([
    ['basic', 'economy', 'general', 'advanced'],
    ['small', 'medium', 'large'],
  ])('gives every configured tier a distinct capability, independent of its name (%s)', (...names) => {
    const result = criteria(names);
    expect(Object.keys(result)).toEqual(names);
    expect(new Set(Object.values(result).map(capability)).size).toBe(names.length);
  });

  it('retains both middle capabilities when collapsing four tiers into three', () => {
    const four = Object.values(criteria(['a', 'b', 'c', 'd'])).map(capability);
    const three = Object.values(criteria(['x', 'y', 'z'])).map(capability);
    expect(three[0]).toBe(four[0]);
    expect(three[1]).toContain(four[1]);
    expect(three[1]).toContain(four[2]);
    expect(three[2]).toBe(four[3]);
  });

  it('handles empty and single-tier ladders', () => {
    expect(Object.keys(criteria(['only']))).toEqual(['only']);
    expect(criteria([])).toEqual({});
  });
});
