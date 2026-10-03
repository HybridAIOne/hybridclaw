import { expect, test } from 'vitest';

import { setChecklistItem } from '../src/gateway/artifact-checklist.js';

const LIST = [
  '# Einkaufsliste',
  '',
  '- [ ] Moos',
  '  - [x] Kiefernzapfen',
  '* [X] Kerzen',
  'Not an item: [ ] here',
  '- [ ]',
  '```',
  '- [ ] in a fence',
  '```',
  '+ [ ]\tKürbis  ',
].join('\n');

test('numbers items in order, nested ones included, skipping code fences', () => {
  const titles = ['Moos', 'Kiefernzapfen', 'Kerzen', 'Kürbis'];
  titles.forEach((title, item) => {
    const update = setChecklistItem(LIST, item, title, true);
    expect(update.ok).toBe(true);
  });
  expect(setChecklistItem(LIST, 3, 'Kürbis', true)).toEqual({
    ok: true,
    content: LIST.replace('+ [ ]\tKürbis', '+ [x]\tKürbis'),
  });
  expect(setChecklistItem(LIST, 4, 'Kürbis', true).ok).toBe(false);
});

test('ticks and unticks only the mark, and a repeat is a no-op', () => {
  const done = setChecklistItem(LIST, 0, 'Moos', true);
  expect(done).toEqual({
    ok: true,
    content: LIST.replace('- [ ] Moos', '- [x] Moos'),
  });
  expect(setChecklistItem(LIST, 2, 'Kerzen', false)).toEqual({
    ok: true,
    content: LIST.replace('* [X] Kerzen', '* [ ] Kerzen'),
  });
  expect(setChecklistItem(LIST, 1, 'Kiefernzapfen', true)).toEqual({
    ok: true,
    content: LIST,
  });
});

test('refuses a title that no longer matches and returns the current text', () => {
  expect(setChecklistItem(LIST, 1, 'Moos', true)).toEqual({
    ok: false,
    error: 'Item 1 is no longer that item.',
    content: LIST,
  });
});

test('keeps CRLF line endings', () => {
  const crlf = '- [ ] Moos\r\n- [ ] Kerzen\r\n';
  expect(setChecklistItem(crlf, 1, 'Kerzen', true)).toEqual({
    ok: true,
    content: '- [ ] Moos\r\n- [x] Kerzen\r\n',
  });
});
