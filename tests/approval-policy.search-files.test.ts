import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-search-files-');
useCleanMocks({ unstubAllEnvs: true });

function evaluate(command: string) {
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(makeTempDir(), 'policy.yaml'),
  );
  runtime.setApprovalMode({ mode: 'full' });
  return runtime.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command }),
    latestUserPrompt: 'Search the source',
  });
}

describe('recursive search with explicit file operands', () => {
  test.each([
    'grep -rn TODO',
    'grep --recursive -e TODO --',
    'egrep -Rn TODO',
    'rg --hidden TODO',
  ])('allows regular files: %s', (prefix) => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'one.py'), 'TODO\n');
    fs.writeFileSync(path.join(dir, 'two.pyx'), 'TODO\n');
    expect(
      evaluate(`${prefix} ${dir}/one.py ${dir}/two.pyx | head -60`),
    ).toMatchObject({ pinned: false });
    expect(evaluate(`cd ${dir} && ${prefix} one.py two.pyx`).pinned).toBe(
      false,
    );
  });

  test.each(['', 'directory', 'missing.py', '*.py', '$TARGET'])(
    'keeps uncertain or directory roots protected: %s',
    (operand) => {
      const dir = makeTempDir();
      fs.mkdirSync(path.join(dir, 'directory'));
      expect(evaluate(`cd ${dir} && grep -rn TODO ${operand}`)).toMatchObject({
        pinned: true,
        decision: 'required',
      });
    },
  );

  test('mixed files and directories retain walk protection', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'file.py'), 'TODO');
    expect(evaluate(`grep -rn TODO ${dir}/file.py ${dir}`)).toMatchObject({
      pinned: true,
    });
  });

  test('explicit sensitive files and symlink aliases stay pinned', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'test-key');
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'alias.py'));
    for (const name of ['.env', 'alias.py']) {
      expect(
        evaluate(`grep -rn --include='*.py' TODO ${dir}/${name}`),
      ).toMatchObject({ pinned: true, decision: 'required' });
    }
  });

  test('a parent-directory alias cannot hide a pinned file', () => {
    const dir = makeTempDir();
    vi.stubEnv('HOME', fs.realpathSync(dir));
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(path.join(dir, '.ssh/id_rsa'), 'test-key');
    fs.symlinkSync(path.join(dir, '.ssh'), path.join(dir, 'alias'));
    expect(evaluate(`grep -rn TODO ${dir}/alias/id_rsa`)).toMatchObject({
      pinned: true,
    });
  });
});
