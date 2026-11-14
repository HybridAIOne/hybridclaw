import { expect, test } from 'vitest';
import {
  commandArguments,
  commandProgram,
  commandWriteTargets,
  redirectWidth,
  scriptCommands,
  shellCommandsRun,
} from '../container/src/bash-commands.js';

test.each([
  "grep '<tag>' .env",
  'grep "<tag>" .env',
  'grep \\<tag\\> .env',
  "env -u FEATURE grep '<tag>' .env",
  "printf '%s' names | xargs grep '<tag>' .env",
  "find . -exec grep '<tag>' .env \\;",
  'sh -c "grep \'<tag>\' .env"',
])('literal input-like patterns retain their argument role: %s', (source) => {
  const words = shellCommandsRun(scriptCommands(source))
    .find((words) => commandProgram(words).program === 'grep');
  expect(words).toBeDefined();
  const { args } = commandProgram(words!);
  expect(args).toEqual(['<tag>', '.env']);
  expect(redirectWidth(args, 0)).toBe(0);
  expect(commandArguments(args)).toEqual(args);
  expect(commandWriteTargets(words!)).toEqual([]);
});

test.each([
  ["printf '%s' '>'", []],
  ['printf x>out', ['out']],
  ['printf x > out', ['out']],
  ['printf x&>out', ['out']],
  ['printf x >"quoted>name"', ['quoted>name']],
  ['printf x 2>&1', []],
  ['printf x >&2', []],
] as const)('only actual output redirects name write targets: %s', (source, expected) => {
  const [{ words }] = scriptCommands(source);
  expect(commandWriteTargets(words)).toEqual(expected);
});

test('a quoted output operator does not swallow a following pipeline', () => {
  expect(scriptCommands("printf '%s' '>' | cat").map(({ program, piped }) => [program, piped]))
    .toEqual([['printf', false], ['cat', true]]);
});

test('redirect targets do not swallow a following command separator', () => {
  const commands = scriptCommands('printf x&>out&&cat out');
  expect(commands.map(({ program }) => program)).toEqual(['printf', 'cat']);
  expect(commandWriteTargets(commands[0].words)).toEqual(['out']);
});
