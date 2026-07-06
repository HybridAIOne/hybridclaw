import { describe, expect, test } from 'vitest';

import {
  approvalOutputPresentation,
  classifyAssistantChatSegment,
  outputPresentationForAssistantSegment,
} from '../container/src/chat-segments.js';
import {
  parseRalphChoice,
  stripRalphChoiceTags,
} from '../container/src/ralph.js';

describe('container ralph helpers', () => {
  test('parses stop choice tags', () => {
    expect(parseRalphChoice('<choice>STOP</choice>')).toBe('STOP');
  });

  test('drops choice-only content from visible output', () => {
    expect(stripRalphChoiceTags('<choice>STOP</choice>')).toBeNull();
  });

  test('preserves text outside ralph choice tags', () => {
    expect(
      stripRalphChoiceTags('First question?\n\n<choice>CONTINUE</choice>'),
    ).toBe('First question?');
  });

  test('preserves ordinary text that has no choice tags', () => {
    expect(stripRalphChoiceTags('Nice to meet you.')).toBe('Nice to meet you.');
  });

  test('classifies Ralph STOP text as final chat text', () => {
    expect(
      classifyAssistantChatSegment({
        content: 'Done.\n\n<choice>STOP</choice>',
        hasToolCalls: false,
        ralphEnabled: true,
      }),
    ).toEqual({
      kind: 'final',
      ralphChoice: 'STOP',
      text: 'Done.',
    });
  });

  test('classifies Ralph text without STOP as a draft', () => {
    expect(
      classifyAssistantChatSegment({
        content: 'I will use the memory tool next.',
        hasToolCalls: false,
        ralphEnabled: true,
      }),
    ).toEqual({
      kind: 'draft',
      ralphChoice: null,
      text: 'I will use the memory tool next.',
    });
  });

  test('classifies structured tool-call turns outside the final bubble', () => {
    expect(
      classifyAssistantChatSegment({
        content: 'Let me update memory.',
        hasToolCalls: true,
        ralphEnabled: true,
      }),
    ).toEqual({
      kind: 'tool_request',
      ralphChoice: null,
      text: 'Let me update memory.',
    });
  });

  test('marks only final assistant segments for assistant-bubble display', () => {
    expect(
      outputPresentationForAssistantSegment(
        classifyAssistantChatSegment({
          content: 'Done.\n\n<choice>STOP</choice>',
          hasToolCalls: false,
          ralphEnabled: true,
        }),
      ),
    ).toEqual({
      segmentKind: 'final',
      visible: true,
      displaySurface: 'assistant_bubble',
    });

    expect(
      outputPresentationForAssistantSegment(
        classifyAssistantChatSegment({
          content: 'Let me update memory.',
          hasToolCalls: true,
          ralphEnabled: true,
        }),
      ),
    ).toEqual({
      segmentKind: 'tool_request',
      visible: false,
      displaySurface: 'none',
    });
  });

  test('marks approval prompts with approval display metadata', () => {
    expect(approvalOutputPresentation()).toEqual({
      segmentKind: 'approval',
      visible: true,
      displaySurface: 'approval',
    });
  });
});
