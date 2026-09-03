import { describe, expect, it } from 'vitest';
import {
  formatMemoryAccessActivityPreview,
  formatMemoryAccessMarkdown,
  formatMemoryAccessSummary,
} from '../src/memory/recall-presentation.js';

describe('memory recall presentation', () => {
  it('reports an attempted lookup even when it has no matches', () => {
    const access = {
      semanticRecallAttempted: true,
      summaryIncluded: false,
      recalledMemories: [],
    };

    expect(formatMemoryAccessSummary(access)).toBe(
      'No relevant memories recalled',
    );
    expect(formatMemoryAccessMarkdown(access)).toBe(
      '*Memory: No relevant memories recalled*',
    );
  });

  it('includes every recalled preview in channel and activity presentation', () => {
    const access = {
      semanticRecallAttempted: true,
      summaryIncluded: true,
      recalledMemories: [
        {
          ref: '[mem:1]',
          memoryId: 3,
          content: 'User prefers concise answers.',
          confidence: 0.92,
        },
      ],
    };

    expect(formatMemoryAccessSummary(access)).toBe(
      'Recalled 1 memory · Session summary accessed',
    );
    expect(formatMemoryAccessActivityPreview(access)).toBe(
      'Recalled 1 memory · Session summary accessed: User prefers concise answers.',
    );
    expect(formatMemoryAccessMarkdown(access)).toContain(
      '[mem:1]: User prefers concise answers. (92%)',
    );
  });
});
