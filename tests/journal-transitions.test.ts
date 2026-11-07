import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  checkpointOutput,
  readTurnCheckpoint,
  TurnCheckpoint,
  turnCheckpointPath,
} from '#shared/turn-checkpoint.js';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('journal-transitions-');
const assistant = {
  role: 'assistant' as const,
  content: null,
  tool_calls: [
    {
      id: 'a',
      type: 'function' as const,
      function: { name: 'write', arguments: '{}' },
    },
  ],
};
const result = { role: 'tool' as const, tool_call_id: 'a', content: 'Saved.' };

function setup() {
  const root = temp();
  const journal = new TurnCheckpoint(root, 'session-a', 'run-a');
  journal.assistant(assistant);
  const file = turnCheckpointPath(root, 'session-a');
  return { root, journal, file };
}

test.each([
  'duplicate-start',
  'start-after-result',
  'conflicting-result',
  'orphan-start',
  'orphan-result',
  'unfinished-exchange',
])(
  'rejects %s without altering durable evidence or poisoning the writer',
  (kind) => {
    const { root, journal, file } = setup();
    journal.start('a');
    if (kind === 'start-after-result' || kind === 'conflicting-result')
      journal.result(result);
    const before = fs.readFileSync(file, 'utf8');
    expect(() => {
      switch (kind) {
        case 'duplicate-start':
        case 'start-after-result':
          journal.start('a');
          break;
        case 'conflicting-result':
          journal.result({ ...result, content: 'Different.' });
          break;
        case 'orphan-start':
          journal.start('missing');
          break;
        case 'orphan-result':
          journal.result({ ...result, tool_call_id: 'missing' });
          break;
        case 'unfinished-exchange':
          journal.assistant(assistant);
          break;
      }
    }).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    journal.result(result);
    expect(
      checkpointOutput(readTurnCheckpoint(root, 'session-a')!).toolHistory[1],
    ).toEqual(result);
  },
);

test('batch assembly may acknowledge an identical result without replacing evidence', () => {
  const { root, journal, file } = setup();
  journal.start('a');
  journal.result(result);
  const before = fs.readFileSync(file, 'utf8');
  journal.result({ ...structuredClone(result), visualAttachments: undefined });
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(readTurnCheckpoint(root, 'session-a')!.messages).toHaveLength(2);
});

test('a terminal receipt without execution cannot subsequently start', () => {
  const { root, journal, file } = setup();
  journal.result({ ...result, content: 'Denied.', is_error: true });
  const before = fs.readFileSync(file, 'utf8');
  expect(() => journal.start('a')).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(readTurnCheckpoint(root, 'session-a')!.started).toEqual([]);
});

test.each(['start', 'result', 'assistant'] as const)(
  'a recovered journal refuses %s and preserves its original evidence',
  (operation) => {
    const { root, journal, file } = setup();
    journal.start('a');
    const recovered = new TurnCheckpoint(root, 'session-a', 'run-a');
    const before = fs.readFileSync(file, 'utf8');
    expect(() => {
      if (operation === 'start') recovered.start('a');
      if (operation === 'result') recovered.result(result);
      if (operation === 'assistant') recovered.assistant(assistant);
    }).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  },
);

test('failed result persistence retains uncertainty and permits recording the actual result later', () => {
  const { root, journal, file } = setup();
  journal.start('a');
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('Disk unavailable.');
  });
  try {
    expect(() => journal.result(result)).toThrow('Disk unavailable.');
  } finally {
    rename.mockRestore();
  }
  expect(
    checkpointOutput(readTurnCheckpoint(root, 'session-a')!).toolHistory[1]
      .is_error,
  ).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).messages).toHaveLength(1);
  journal.result(result);
  expect(
    checkpointOutput(readTurnCheckpoint(root, 'session-a')!).toolHistory[1],
  ).toEqual(result);
});

test('failed start persistence never invokes the tool and can retry the unexecuted start', async () => {
  const root = temp();
  const history = new TurnToolHistory('session-a', root, root, 'run-a');
  history.recordAssistant(assistant);
  const execute = vi.fn(async () => ({ output: 'Saved.', isError: false }));
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('Disk unavailable.');
  });
  try {
    await expect(history.checkpointExecution('a', execute)).rejects.toThrow(
      'Disk unavailable.',
    );
  } finally {
    rename.mockRestore();
  }
  expect(execute).not.toHaveBeenCalled();
  expect(readTurnCheckpoint(root, 'session-a')!.started).toEqual([]);
  await history.checkpointExecution('a', execute);
  expect(execute).toHaveBeenCalledTimes(1);
  history.recordResult(result);
});

test.each([null, {}, { version: 1, turnId: '', messages: [], started: [] }])(
  'validates the envelope even when projecting evidence directly: %s',
  (data) => {
    expect(() => checkpointOutput(data as never)).toThrow();
  },
);

test('reader refuses a corrupt journal that advances beyond an unfinished exchange', () => {
  const { root, journal, file } = setup();
  journal.start('a');
  const data = readTurnCheckpoint(root, 'session-a')!;
  data.messages.push(assistant);
  fs.writeFileSync(file, JSON.stringify(data));
  expect(() => readTurnCheckpoint(root, 'session-a')).toThrow();
});
