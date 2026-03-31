import { expect, test } from 'vitest';
import { prepareIMessageTextChunks } from '../src/channels/imessage/delivery.js';

test('chunks long iMessage text on preferred boundaries', () => {
  const chunks = prepareIMessageTextChunks(
    ['alpha '.repeat(40), 'beta '.repeat(40), 'gamma '.repeat(40)].join('\n'),
    200,
  );

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]).toContain('alpha');
  expect(chunks.join('\n')).toContain('gamma');
});

test('returns a placeholder chunk for empty content', () => {
  expect(prepareIMessageTextChunks('', 4000)).toEqual(['(no content)']);
});
