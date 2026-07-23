import { expect, test } from 'vitest';
import {
  decodeEntities,
  stripTags,
} from '../container/src/search-utils.js';

test('HTML entity decoding performs exactly one decoding pass', () => {
  expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe(
    '&lt;script&gt;',
  );
  expect(decodeEntities('A&nbsp;B &quot;C&quot; &#x41; &#65;')).toBe(
    'A B "C" A A',
  );
});

test('HTML tag stripping handles nested tag-like input without leaving an active tag', () => {
  const stripped = stripTags('<script<script>>alert(1)</script >safe');
  expect(stripped).not.toContain('<script');
  expect(stripped).toContain('safe');
});
