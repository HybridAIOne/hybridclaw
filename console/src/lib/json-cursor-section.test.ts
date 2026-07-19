import { describe, expect, it } from 'vitest';
import { findTopLevelJsonSection } from './json-cursor-section';

const JSON_TEXT = JSON.stringify(
  {
    version: 1,
    discord: { enabled: true, nested: { value: 1 } },
    scheduler: { jobs: [] },
  },
  null,
  2,
);

describe('findTopLevelJsonSection', () => {
  it('returns the top-level section containing the cursor', () => {
    expect(
      findTopLevelJsonSection(JSON_TEXT, JSON_TEXT.indexOf('"enabled"')),
    ).toBe('discord');
    expect(
      findTopLevelJsonSection(JSON_TEXT, JSON_TEXT.indexOf('"jobs"')),
    ).toBe('scheduler');
  });

  it('does not mistake nested object keys for sections', () => {
    expect(
      findTopLevelJsonSection(JSON_TEXT, JSON_TEXT.indexOf('"value"')),
    ).toBe('discord');
  });

  it('returns null before the first top-level key', () => {
    expect(findTopLevelJsonSection(JSON_TEXT, 0)).toBeNull();
  });
});
