import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { sedWriteTargets } from '../container/src/bash-sed-targets.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hc-sed-cli-');
const gnu =
  spawnSync('sed', ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
  }).stdout?.includes('GNU sed') === true;
const script = 's/before/after/';
const cases = [
  {
    name: 'portable backup',
    file: 'notes.txt',
    args: ['-i.bak', script, 'notes.txt'],
    backup: 'notes.txt.bak',
  },
  {
    name: 'clustered backup',
    file: 'notes.txt',
    args: ['-Ei.bak', script, 'notes.txt'],
    backup: 'notes.txt.bak',
  },
  {
    name: 'script input',
    file: 'notes.txt',
    args: ['-i.bak', '-f', 'script.sed', 'notes.txt'],
    backup: 'notes.txt.bak',
  },
  {
    name: 'no backup',
    file: 'notes.txt',
    args: (gnu ? ['-i'] : ['-i', '']).concat(script, 'notes.txt'),
    backup: '',
  },
  {
    name: 'platform syntax',
    file: 'notes.txt',
    args: gnu
      ? ['--in-place=.bak', '--expression=' + script, 'notes.txt']
      : ['-I.bak', script, 'notes.txt'],
    backup: 'notes.txt.bak',
  },
  {
    name: 'star backup',
    file: 'notes.txt',
    args: ['-iprefix*', script, 'notes.txt'],
    backup: gnu ? 'prefixnotes.txt' : 'notes.txtprefix*',
  },
  ...['$&', "$'", '$`', '$$'].map((file) => ({
    name: 'literal filename ' + file,
    file,
    args: ['-iprefix*', script, file],
    backup: gnu ? 'prefix' + file : file + 'prefix*',
  })),
];

test.each(cases)(
  'sed target roles match the installed binary: $name',
  ({ file, args, backup }) => {
    const root = temp();
    fs.writeFileSync(path.join(root, file), 'before\n');
    fs.writeFileSync(path.join(root, 'script.sed'), script + '\n');
    execFileSync('sed', args, { cwd: root, timeout: 10000 });
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe('after\n');
    const predicted = sedWriteTargets('sed', args).map((value) =>
      path.resolve(root, value),
    );
    expect(predicted).toContain(path.join(root, file));
    if (backup) {
      expect(fs.readFileSync(path.join(root, backup), 'utf8')).toBe('before\n');
      expect(predicted).toContain(path.join(root, backup));
    } else
      expect(fs.readdirSync(root).sort()).toEqual([file, 'script.sed'].sort());
  },
);

test('sed platform-specific path effects stay visible', () => {
  const root = temp();
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'before\n');
  const args = gnu
    ? ['-i../*', script, 'notes.txt']
    : ['-i.bak', script, 'notes.txt', '-e', path.join(cwd, 'other')];
  if (!gnu)
    for (const file of ['-e', 'other'])
      fs.writeFileSync(path.join(cwd, file), 'before\n');
  execFileSync('sed', args, { cwd, timeout: 10000 });
  const predicted = sedWriteTargets('sed', args).map((value) =>
    path.resolve(cwd, value),
  );
  if (gnu) {
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe(
      'before\n',
    );
    expect(predicted).toContain(path.join(root, 'notes.txt'));
  } else
    for (const file of ['notes.txt', '-e', 'other']) {
      expect(fs.readFileSync(path.join(cwd, file), 'utf8')).toBe('after\n');
      expect(predicted).toContain(path.join(cwd, file));
    }
});
