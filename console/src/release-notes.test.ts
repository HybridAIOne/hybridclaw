import { describe, expect, it } from 'vitest';
import consolePackage from '../package.json';
import { LATEST_RELEASE_NOTES } from './release-notes';

describe('release notes', () => {
  it('describes the current console release', () => {
    expect(LATEST_RELEASE_NOTES.version).toBe(consolePackage.version);
  });

  it('keeps the popup copy ultra short', () => {
    expect(LATEST_RELEASE_NOTES.highlights.length).toBeLessThanOrEqual(4);
    for (const highlight of LATEST_RELEASE_NOTES.highlights) {
      expect(highlight.length).toBeLessThanOrEqual(48);
    }
  });
});
