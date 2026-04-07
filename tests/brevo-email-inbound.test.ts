import { expect, test, vi } from 'vitest';

vi.mock('hybridclaw/plugin-sdk', () => ({}));

import {
  buildKnownAgentIds,
  extractText,
} from '../plugins/brevo-email/src/brevo-inbound.js';

test('extractText preserves plain text bodies without HTML conversion', () => {
  expect(
    extractText({
      From: { Address: 'alice@example.com' },
      To: [{ Address: 'main@example.com' }],
      RawTextBody: 'plain text body',
    }),
  ).toBe('plain text body');
});

test('extractText uses parser-backed HTML conversion for malformed markup', () => {
  const text = extractText({
    From: { Address: 'alice@example.com' },
    To: [{ Address: 'main@example.com' }],
    RawHtmlBody:
      '<p>Hello</p><scr<script>ipt>alert(1)</scr</script>ipt><br>World',
  });

  expect(text).toContain('Hello');
  expect(text).toContain('World');
  expect(text).not.toContain('<script');
  expect(text).not.toContain('<scr');
  expect(text).not.toContain('</script>');
});

test('buildKnownAgentIds normalizes configured and default agent ids once', () => {
  expect(
    buildKnownAgentIds({
      agents: {
        defaultAgentId: ' Main ',
        list: [{ id: 'Writer' }, { id: ' reviewer ' }, { id: '' }],
      },
    }),
  ).toEqual(new Set(['main', 'writer', 'reviewer']));
});
