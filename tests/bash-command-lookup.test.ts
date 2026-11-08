import { expect, test } from 'vitest';
import {
  commandProgram,
  isCommandLookup,
  scriptCommands,
  shellCommandsRun,
} from '../container/src/bash-commands.js';

test.each([
  'command -v sh',
  'command -V sh',
  'command -pv sh',
  'command -Vp sh',
  'command -p -v sh',
  'command -v -p sh',
  'command -p -V sh',
  'command -v -- sh node',
  'command -v -- -p',
  'command 2>/dev/null -v sh',
  'command -v sh >/dev/null',
])('a literal lookup has no executable operand: %s', (command) => {
  const words = shellCommandsRun(scriptCommands(command, '/workspace'))[0];
  expect(isCommandLookup(words)).toBe(true);
  expect(commandProgram(words).program).toBe('');
});

test.each([
  'command',
  'command -p sh script.sh',
  'command -- sh script.sh',
  'command -- -v sh',
  'command --version',
  'command -unknown sh',
  'command -v -unknown sh',
  'command -v -px sh',
  'printf command -v',
])('execution or unknown options are not lookups: %s', (command) => {
  expect(
    isCommandLookup(shellCommandsRun(scriptCommands(command, '/workspace'))[0]),
  ).toBe(false);
});

test.each([
  ['command -p rm notes.txt', 'rm'],
  ['command -- node script.js', 'node'],
  ['command -p -p sh script.sh', 'sh'],
])('execution keeps its actual program: %s', (command, expected) => {
  expect(
    commandProgram(shellCommandsRun(scriptCommands(command, '/workspace'))[0])
      .program,
  ).toBe(expected);
});
