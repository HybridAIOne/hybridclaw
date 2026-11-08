import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { tarWriteTargets } from '../container/src/bash-tar-targets.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-tar-cli-');
const version = execFileSync('tar', ['--version'], {
  encoding: 'utf8',
  timeout: 10000,
});
const cases = [
  {
    name: 'extract',
    args: ['-xf', 'bundle.tar', '-C', 'out'],
    output: 'out/notes.txt',
    target: 'out',
  },
  {
    name: 'traditional extract',
    args: ['xCf', 'out', 'bundle.tar'],
    output: 'out/notes.txt',
    target: 'out',
  },
  {
    name: 'relative directories',
    args: ['-xf', 'bundle.tar', '-C', 'nested', '-C', '../out'],
    output: 'out/notes.txt',
    target: 'out',
  },
  {
    name: 'create',
    args: ['-cf', 'created.tar', '-C', 'out', 'notes.txt'],
    output: 'created.tar',
    target: 'created.tar',
  },
  {
    name: 'traditional compressed create',
    args: ['cfz', 'created.tgz', 'notes.txt'],
    output: 'created.tgz',
    target: 'created.tgz',
  },
  {
    name: 'attached short option value',
    args: ['-cfz', 'notes.txt'],
    output: 'z',
    target: 'z',
  },
  {
    name: 'stdout extraction',
    args: ['-xOf', 'bundle.tar', 'notes.txt'],
    output: '',
    target: '',
  },
  { name: 'listing', args: ['-tf', 'bundle.tar'], output: '', target: '' },
  /GNU/.test(version)
    ? {
        name: 'GNU flag arity',
        args: ['-s', '-xf', 'bundle.tar', '-C', 'out'],
        output: 'out/notes.txt',
        target: 'out',
      }
    : {
        name: 'BSD flag arity',
        args: ['-H', '-cf', 'created.tar', 'notes.txt'],
        output: 'created.tar',
        target: 'created.tar',
      },
];

test.each(cases)(
  'tar target roles match the installed binary: $name',
  ({ name, args, output, target }) => {
    const root = temp();
    const content = 'Archive fixture\n';
    fs.writeFileSync(path.join(root, 'notes.txt'), content);
    fs.mkdirSync(path.join(root, 'out'));
    fs.mkdirSync(path.join(root, 'nested'));
    const run = (argv: string[]) =>
      execFileSync('tar', argv, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
      });
    run(['-cf', 'bundle.tar', 'notes.txt']);
    if (name === 'create')
      fs.writeFileSync(path.join(root, 'out/notes.txt'), content);
    const result = run(args);
    if (output.endsWith('.txt'))
      expect(fs.readFileSync(path.join(root, output), 'utf8')).toBe(content);
    else if (output) expect(run(['-xOf', output, 'notes.txt'])).toBe(content);
    else if (name === 'listing') expect(result).toContain('notes.txt');
    else expect(result).toBe(content);
    expect(
      tarWriteTargets(args).targets.map((value) => path.resolve(root, value)),
    ).toEqual(target ? [path.resolve(root, target)] : []);
  },
);
