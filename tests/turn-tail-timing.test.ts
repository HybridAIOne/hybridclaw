import { beforeEach, expect, test, vi } from 'vitest';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn() }));
vi.mock('../src/logger.js', () => ({ logger }));

import {
  SLOW_TURN_TAIL_MS,
  TurnTailTimer,
} from '../src/gateway/turn-tail-timing.js';

beforeEach(() => {
  logger.debug.mockClear();
  logger.info.mockClear();
});

test('measures each phase from the last streamed text onwards', () => {
  const tail = new TurnTailTimer();
  tail.noteTextDelta(1_000);
  tail.noteTextDelta(1_100);
  tail.mark('agentReturn', 1_350);
  tail.mark('storeTurn', 1_400);
  tail.mark('postTurn', 2_000);

  expect(tail.summary(2_010)).toEqual({
    lastTextToNowMs: 910,
    phasesMs: { agentReturn: 250, storeTurn: 50, postTurn: 600 },
  });
});

test('opens at the first mark when nothing was streamed', () => {
  const tail = new TurnTailTimer();
  tail.mark('agentReturn', 500);
  tail.mark('storeTurn', 520);

  expect(tail.summary(530)).toEqual({
    lastTextToNowMs: null,
    phasesMs: { storeTurn: 20 },
  });
});

test('logs slow tails at info and the rest at debug', () => {
  const fast = new TurnTailTimer();
  fast.noteTextDelta(0);
  fast.mark('finish', 10);
  fast.log({ sessionId: 's1' }, 'tail', 10);
  expect(logger.debug).toHaveBeenCalledWith(
    { sessionId: 's1', lastTextToNowMs: 10, phasesMs: { finish: 10 } },
    'tail',
  );
  expect(logger.info).not.toHaveBeenCalled();

  const slow = new TurnTailTimer();
  slow.noteTextDelta(0);
  slow.mark('postTurn', SLOW_TURN_TAIL_MS);
  slow.log({ sessionId: 's2' }, 'tail', SLOW_TURN_TAIL_MS);
  expect(logger.info).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 's2',
      lastTextToNowMs: SLOW_TURN_TAIL_MS,
    }),
    'tail',
  );

  const silent = new TurnTailTimer();
  silent.mark('finish', 10_000);
  silent.log({ sessionId: 's3' }, 'tail', 10_000);
  expect(logger.info).toHaveBeenCalledTimes(1);
});
