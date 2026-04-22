import { expect, test } from 'vitest';

import {
  buildSessionBoundaryPreview,
  buildSessionConversationPreview,
  buildSessionSearchSnippet,
  shouldIncludeSessionSearchSnippet,
  trimSessionPreviewText,
} from '../src/session/session-preview.ts';

test('trimSessionPreviewText returns null for nullish and empty input', () => {
  expect(trimSessionPreviewText(null)).toBeNull();
  expect(trimSessionPreviewText(undefined)).toBeNull();
  expect(trimSessionPreviewText('')).toBeNull();
  expect(trimSessionPreviewText('   \n\t  ')).toBeNull();
});

test('buildSessionBoundaryPreview combines first and last snippets', () => {
  expect(
    buildSessionBoundaryPreview({
      firstMessage:
        'First message that should be kept near the start of the preview.',
      lastMessage:
        'Last message that should also appear so recent chat lists carry more context.',
      maxLength: 24,
    }),
  ).toBe('"First message that sh..." ... "Last message that sho..."');
});

test('buildSessionBoundaryPreview collapses identical first and last snippets', () => {
  expect(
    buildSessionBoundaryPreview({
      firstMessage: 'Same boundary message',
      lastMessage: 'Same boundary message',
    }),
  ).toBe('"Same boundary message"');
});

test('shouldIncludeSessionSearchSnippet ignores edge ellipses when the title already shows the text', () => {
  expect(
    shouldIncludeSessionSearchSnippet(
      '"Review deployment rollback planning notes"',
      '...deployment rollback planning notes...',
    ),
  ).toBe(false);
});

test('buildSessionSearchSnippet clamps the final decorated snippet to maxLength', () => {
  const snippet = buildSessionSearchSnippet(
    'Intro words before deployment rollback guidance with extra trailing context that pushes the decorated snippet over the requested limit.',
    'deployment rollback guidance',
    28,
  );

  expect(snippet).not.toBeNull();
  expect(snippet?.length).toBeLessThanOrEqual(28);
});

test('buildSessionConversationPreview returns the latest user and assistant snippets', () => {
  expect(
    buildSessionConversationPreview([
      { role: 'user', content: 'Initial prompt' },
      { role: 'assistant', content: 'Initial answer' },
      { role: 'user', content: 'Most recent question with extra detail' },
      { role: 'assistant', content: 'Most recent answer with extra detail' },
    ]),
  ).toEqual({
    lastQuestion: 'Most recent question with extra detail',
    lastAnswer: 'Most recent answer with extra detail',
  });
});

test('buildSessionConversationPreview handles sessions with no user messages', () => {
  expect(
    buildSessionConversationPreview([
      { role: 'assistant', content: 'Initial answer' },
      { role: 'assistant', content: 'Most recent answer' },
    ]),
  ).toEqual({
    lastQuestion: null,
    lastAnswer: 'Most recent answer',
  });
});

test('buildSessionConversationPreview handles sessions with no assistant messages', () => {
  expect(
    buildSessionConversationPreview([
      { role: 'user', content: 'Initial prompt' },
      { role: 'user', content: 'Most recent question' },
    ]),
  ).toEqual({
    lastQuestion: 'Most recent question',
    lastAnswer: null,
  });
});
