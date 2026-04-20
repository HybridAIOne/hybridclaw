import { describe, expect, test } from 'vitest';

import {
  appendSteeringCheckpointMessage,
  appendSteeringNotesToToolMessages,
  buildSteeringCheckpointPrompt,
} from '../container/src/steering.js';

describe('container steering checkpoints', () => {
  test('builds a single-note steering prompt', () => {
    expect(
      buildSteeringCheckpointPrompt([
        {
          note: 'Use the smaller diff first.',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ]),
    ).toContain('User note:\nUse the smaller diff first.');
  });

  test('numbers multiple queued steering notes in order', () => {
    expect(
      buildSteeringCheckpointPrompt([
        {
          note: 'Finish the refactor before polishing.',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
        {
          note: 'Skip unrelated README edits.',
          createdAt: '2026-04-19T10:01:00.000Z',
        },
      ]),
    ).toContain(
      'User notes:\n1. Finish the refactor before polishing.\n2. Skip unrelated README edits.',
    );
  });

  test('appends a user checkpoint message only when notes are present', () => {
    const history = [{ role: 'assistant' as const, content: 'working' }];

    const prompt = appendSteeringCheckpointMessage({
      history,
      notes: [
        {
          note: 'Change direction here.',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
    });

    expect(prompt).toContain('Change direction here.');
    expect(history.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining('Change direction here.'),
    });
    expect(
      appendSteeringCheckpointMessage({
        history,
        notes: [],
      }),
    ).toBeNull();
  });

  test('appends queued steering notes to the last recent tool result', () => {
    const history = [
      { role: 'assistant' as const, content: null },
      { role: 'tool' as const, tool_call_id: 'a', content: 'first result' },
      { role: 'tool' as const, tool_call_id: 'b', content: 'second result' },
    ];

    const marker = appendSteeringNotesToToolMessages({
      history,
      recentToolMessageCount: 2,
      notes: [
        {
          note: 'Use the smaller diff first.',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
    });

    expect(marker).toContain('USER STEER');
    expect(history[1]).toEqual({
      role: 'tool',
      tool_call_id: 'a',
      content: 'first result',
    });
    expect(history[2]).toEqual({
      role: 'tool',
      tool_call_id: 'b',
      content: expect.stringContaining('second result'),
    });
    expect(history[2]?.content).toContain('Use the smaller diff first.');
  });

  test('preserves multimodal tool results when steering is appended', () => {
    const history = [
      {
        role: 'tool' as const,
        tool_call_id: 'a',
        content: [{ type: 'text' as const, text: 'existing output' }],
      },
    ];

    appendSteeringNotesToToolMessages({
      history,
      recentToolMessageCount: 1,
      notes: [
        {
          note: 'Change direction here.',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
    });

    expect(history[0]?.content).toEqual([
      { type: 'text', text: 'existing output' },
      {
        type: 'text',
        text: expect.stringContaining('Change direction here.'),
      },
    ]);
  });
});
