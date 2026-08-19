import path from 'node:path';

import { describe, expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-msteams-reactions-');

async function setup() {
  const db = await import('../src/memory/db.js');
  db.initDatabase({
    quiet: true,
    dbPath: path.join(makeTempDir(), 'reactions.db'),
  });
  return import('../src/channels/msteams/reactions.js');
}

describe('msteams reaction rating helpers', () => {
  test('maps Teams reaction types to ratings', async () => {
    const { mapMSTeamsReactionToRating } = await import(
      '../src/channels/msteams/reactions.js'
    );

    expect(mapMSTeamsReactionToRating('like')).toBe('up');
    expect(mapMSTeamsReactionToRating('PlusOne')).toBe('up');
    expect(mapMSTeamsReactionToRating('+1')).toBe('up');
    expect(mapMSTeamsReactionToRating('thumbsup')).toBe('up');
    expect(mapMSTeamsReactionToRating('dislike')).toBe('down');
    expect(mapMSTeamsReactionToRating('thumbsdown')).toBe('down');
    expect(mapMSTeamsReactionToRating('-1')).toBe('down');
    expect(mapMSTeamsReactionToRating('heart')).toBeNull();
    expect(mapMSTeamsReactionToRating('laugh')).toBeNull();
    expect(mapMSTeamsReactionToRating('')).toBeNull();
    expect(mapMSTeamsReactionToRating(undefined)).toBeNull();
  });

  test('records and resolves rating targets per activity id', async () => {
    const reactions = await setup();

    reactions.recordMSTeamsRatingTargets({
      sessionId: 's1',
      activityIds: ['a1', 'a2', ' '],
      messageId: 7,
    });
    reactions.recordMSTeamsRatingTargets({
      sessionId: 's1',
      activityIds: ['a3'],
      messageId: 9,
    });

    expect(reactions.resolveMSTeamsRatingTarget('s1', 'a1')).toBe(7);
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'a2')).toBe(7);
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'a3')).toBe(9);
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'missing')).toBeNull();
    expect(reactions.resolveMSTeamsRatingTarget('s2', 'a1')).toBeNull();

    reactions.recordMSTeamsRatingTargets({
      sessionId: 's1',
      activityIds: ['a1'],
      messageId: 11,
    });
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'a1')).toBe(11);
  });

  test('ignores invalid targets and caps stored entries', async () => {
    const reactions = await setup();

    reactions.recordMSTeamsRatingTargets({
      sessionId: 's1',
      activityIds: [],
      messageId: 7,
    });
    reactions.recordMSTeamsRatingTargets({
      sessionId: 's1',
      activityIds: ['a1'],
      messageId: 0,
    });
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'a1')).toBeNull();

    for (let index = 1; index <= 105; index += 1) {
      reactions.recordMSTeamsRatingTargets({
        sessionId: 's1',
        activityIds: [`activity-${index}`],
        messageId: index,
      });
    }
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'activity-1')).toBeNull();
    expect(reactions.resolveMSTeamsRatingTarget('s1', 'activity-105')).toBe(
      105,
    );
  });
});
