import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { guardCommand } from '../container/src/bash-safety.js';
import { configureSafetyRules } from '../container/src/safety-rules.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawn.mockImplementation(actual.spawnSync);
  return { ...actual, spawnSync: spawn };
});
useCleanMocks({
  cleanup: () => {
    spawn.mockClear();
    configureSafetyRules(undefined);
  },
});
const temporary = useTempDir('python-comments-');

function heredoc(source: string, header = "python3 <<'PY'"): string {
  return `${header}\n${source}\nPY`;
}

test.each([
  heredoc("# eval results are data\nprint('done')"),
  heredoc("print('done') # eval summary", "cd /workspace && python3 << 'PY'"),
  heredoc("text = '# sign'; print(text) # eval", 'python3 <<"PY"'),
  heredoc("print('é') # eval\n# second comment", "python3.11 <<'PY'"),
  heredoc("print('done') # 😀 eval\n# \u2028 eval"),
  `${heredoc("print('done') # eval")}\n`,
  heredoc("# eval\nprint('done')").replaceAll('\n', '\r\n'),
])('Python comments do not stop a quoted stdin program: %s', (command) => {
  expect(guardCommand(command)).toBeNull();
  expect(spawn).toHaveBeenCalledTimes(1);
});

test.each([
  heredoc("# eval summary\neval('1')"),
  heredoc("text = '# eval'; print(text)"),
  heredoc('text = """\n# eval\n"""; print(text)'),
  heredoc('print(f"{eval(\'1\')}")'),
  heredoc("# eval\nprint('unterminated)"),
  heredoc("# eval\nprint('done')", 'node <<\'PY\''),
  heredoc("# $(eval 'printf marker')", 'python3 <<PY'),
  heredoc("# eval\nprint('done')", "python3 - <<'PY'"),
  heredoc("# eval\nprint('done')", "env python3 <<'PY'"),
  heredoc("# eval\nprint('done')", "echo python3 <<'PY'"),
  heredoc("# eval\nprint('done')", "python3 <<-'PY'"),
  heredoc("# eval\nprint('done')", "python3 <<'P'\"Y\""),
  heredoc("# eval\nprint('done')", "python3 <<'PY' | cat"),
  heredoc("# eval\nprint('done')", "python3 <<'PY' <<'OTHER'"),
  `${heredoc("# eval\nprint('done')")}\neval 'printf marker'`,
  `${heredoc("# eval\nprint('done')")}\nPY`,
  `${heredoc("# eval\nprint('done')")}   `,
  "python3 <<'PY'\n# eval\nprint('done')",
  heredoc('# coding: raw_unicode_escape\n# eval summary\n# \\u000aeval("1")'),
  heredoc('# coding: latin-1\n# eval\nprint("done")'),
])('code, strings, expansions and unsupported input stay blocked: %s', (command) => {
  expect(guardCommand(command)).toContain('safety rule eval:');
});

test('comment filtering does not disable independent safety rules', () => {
  const result = guardCommand(heredoc("# eval; rm -rf /example\nprint('done')"));
  expect(result).not.toContain('safety rule eval:');
  expect(result).toContain('safety rule recursive-delete:');
});

test.each([
  { status: null, error: new Error('ENOENT'), stdout: '' },
  { status: null, error: new Error('ETIMEDOUT'), stdout: '' },
  { status: 1, stdout: '' },
  { status: 0, stdout: 'malformed' },
  { status: 0, stdout: 'null' },
  { status: 0, stdout: '{}' },
  { status: 0, stdout: null },
])('failed inspection retains the hard block: %j', (result) => {
  spawn.mockReturnValueOnce(result);
  expect(guardCommand(heredoc("# eval\nprint('done')"))).toContain(
    'safety rule eval:',
  );
});

test('input and syntax-tree budgets retain the hard block', () => {
  expect(guardCommand(heredoc(`# eval\n${'#'.repeat(32769)}`))).toContain(
    'safety rule eval:',
  );
  expect(spawn).not.toHaveBeenCalled();
  expect(guardCommand(heredoc(`# eval\n${'1\n'.repeat(2500)}`))).toContain(
    'safety rule eval:',
  );
});

test('ordinary commands and heredocs without the matching word need no parser', () => {
  expect(guardCommand('python3 --version')).toBeNull();
  expect(guardCommand(heredoc("print('done')"))).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});

test('inspection never executes the supplied program', () => {
  const marker = path.join(temporary(), 'unexpected');
  const command = heredoc(`# eval\nopen(${JSON.stringify(marker)}, 'w').write('executed')`);
  expect(guardCommand(command)).toBeNull();
  expect(fs.existsSync(marker)).toBe(false);
});

test('explicitly disabled eval does not invoke the parser or disable other rules', () => {
  configureSafetyRules(['eval']);
  expect(guardCommand(heredoc("# eval\nprint('done')"))).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
  expect(guardCommand(heredoc('# eval; rm -rf /example'))).toContain(
    'safety rule recursive-delete:',
  );
});
