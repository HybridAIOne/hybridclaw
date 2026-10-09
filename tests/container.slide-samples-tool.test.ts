import { expect, test } from 'vitest';

import {
  parseSlideSamplesArgs,
  runSlideSamplesTool,
} from '../container/src/tools/slide-samples.ts';

test('reads looks, formats and question, clipped to what the card shows', () => {
  expect(
    parseSlideSamplesArgs({
      looks: [
        {
          title: 'Calm and light',
          note: '  Lots of white\nspace ',
          slide: 'decks/look-1.html',
        },
        { title: 'B'.repeat(60), slide: 'decks/look-2.png' },
      ],
      formats: ['google_slides', 'keynote'],
      question: 'Welcher Look?',
    }),
  ).toEqual({
    looks: [
      {
        title: 'Calm and light',
        note: 'Lots of white space',
        slide: 'decks/look-1.html',
      },
      { title: `${'B'.repeat(39)}…`, slide: 'decks/look-2.png' },
    ],
    formats: ['google_slides'],
    question: 'Welcher Look?',
  });
  expect(
    parseSlideSamplesArgs({
      looks: [
        { title: 'A', slide: 'a.html' },
        { title: 'B', slide: 'b.html' },
      ],
    }),
  ).toMatchObject({ formats: ['powerpoint'] });
});

test('asks the model to fix a call the card cannot show', () => {
  expect(
    parseSlideSamplesArgs({ looks: [{ title: 'A', slide: 'a.html' }] }),
  ).toHaveProperty('error');
  expect(
    parseSlideSamplesArgs({
      looks: [
        { title: 'A', slide: 'a.html' },
        { note: 'no title', slide: 'b.html' },
      ],
    }),
  ).toHaveProperty('error');
  expect(
    parseSlideSamplesArgs({
      looks: [
        { title: 'A', slide: 'deck.pptx' },
        { title: 'B', slide: 'b.html' },
      ],
    }),
  ).toHaveProperty('error');
});

test('fails without rendering when a slide is not in the workspace', async () => {
  const result = await runSlideSamplesTool({
    looks: [
      { title: 'A', slide: 'missing-look-1.html' },
      { title: 'B', slide: 'missing-look-2.html' },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.text).toContain('was not found');
});
