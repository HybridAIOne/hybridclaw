import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-search-files-');
useCleanMocks({ unstubAllEnvs: true });

function evaluate(command: string, mode: 'full' | 'ask' = 'full') {
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(makeTempDir(), 'policy.yaml'),
  );
  runtime.setApprovalMode({ mode });
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

  test('an initial grep against a missing absolute file can report no such file', () => {
    const dir = fs.realpathSync(makeTempDir());
    expect(
      evaluate(`grep -rn 'adapt_delta\\|window' ${dir}/arguments.py | head; python3 - <<'EOF'\nprint('metadata')\nEOF`),
    ).toMatchObject({ pinned: false, decision: 'approved_fullauto' });
  });

  test('an initial suffix glob can resolve to regular files without walk approval', () => {
    const dir = fs.realpathSync(makeTempDir());
    fs.writeFileSync(path.join(dir, 'one.py'), 'TODO\n');
    fs.writeFileSync(path.join(dir, 'two.py'), 'TODO\n');
    fs.mkdirSync(path.join(dir, 'subdirectory'));
    expect(
      evaluate(`grep -rn TODO ${dir}/*.py | head; grep -n TODO ${dir}/one.py 2>/dev/null | head`),
    ).toMatchObject({ pinned: false, decision: 'auto' });
  });

  test('shell startup code and nullglob keep suffix operands unresolved', () => {
    const dir = fs.realpathSync(makeTempDir());
    fs.writeFileSync(path.join(dir, 'one.py'), 'TODO\n');
    vi.stubEnv('BASHOPTS', 'dotglob:nullglob');
    expect(evaluate(`grep -rn TODO ${dir}/*.py | head`).pinned).toBe(true);
    vi.stubEnv('BASHOPTS', 'dotglob');
    vi.stubEnv('BASH_ENV', path.join(dir, 'profile'));
    expect(evaluate(`grep -rn TODO ${dir}/*.py | head`).pinned).toBe(true);
  });

  test('full-auto can replan a file-only search following an opaque command', () => {
    const dir = fs.realpathSync(makeTempDir());
    fs.writeFileSync(path.join(dir, 'one.py'), 'TODO\n');
    const command = `python3 - <<'EOF'\nprint('metadata')\nEOF\ngrep -rn TODO ${dir}/*.py 2>/dev/null | head`;
    expect(evaluate(command)).toMatchObject({
      actionKey: 'bash:grep-file-search',
      decision: 'denied',
    });
    expect(evaluate(command).requestId).toBeUndefined();
    for (const result of [
      evaluate(command, 'ask'),
      evaluate(`${command}; grep -rn TODO ${dir}`),
      evaluate(`${command}; cat /etc/passwd`),
    ]) {
      expect(result).toMatchObject({ pinned: true, decision: 'required' });
    }
  });

  test('full-auto rejects a package directory walk without prompting for an optional diagnostic', () => {
    const dir = fs.realpathSync(makeTempDir());
    const pkg = path.join(dir, 'site-packages', 'example');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, '.env'), 'TOKEN=test-key');
    fs.symlinkSync(pkg, path.join(dir, 'site-packages', 'alias'));
    const command = `grep -rn parameter ${pkg}/ | grep -v pyc | head`;
    expect(evaluate(command)).toMatchObject({
      actionKey: 'bash:grep-file-search', decision: 'denied', pinned: true,
    });
    for (const result of [
      evaluate(command, 'ask'),
      evaluate(command.replace('/example/', '/alias/')),
      evaluate(`${command}; cat ${pkg}/.env`),
    ]) {
      expect(result).toMatchObject({ pinned: true, decision: 'required' });
    }
  });

  test('pip config diagnostics can retry while standalone credential reads stay pinned', () => {
    const command = 'pip config list 2>/dev/null; cat /etc/pip.conf 2>/dev/null; curl -sI https://pypi.org/simple/example/ | head -3';
    expect(evaluate(command)).toMatchObject({
      actionKey: 'bash:pip-config-diagnostic', decision: 'denied', pinned: true,
    });
    for (const result of [
      evaluate(command, 'ask'),
      evaluate('cat /etc/pip.conf'),
      evaluate(`${command}; cat /etc/passwd`),
    ]) {
      expect(result).toMatchObject({ pinned: true, decision: 'required' });
    }
  });

  test.each([
    'grep -rn TODO DIR/missing/arguments.py | head',
    'grep -rn TODO DIR/*.js | head',
    'grep -rn TODO DIR/alias/*.py | head',
    'grep -rn TODO DIR/broken.py | head',
    'grep -rn TODO DIR/*.py | head',
    'grep -rn TODO DIR/*.txt | head',
    'grep -rn TODO DIR/.env.example | head',
    'mkdir DIR/arguments.py; grep -rn TODO DIR/arguments.py | head',
    'grep -rn TODO DIR/arguments.py | tee DIR/out.txt',
    'grep -rn TODO DIR/arguments.py | (head; mkdir DIR/arguments.py)',
    'grep -rn TODO DIR/arguments.py | head & mkdir DIR/arguments.py',
    'grep -rn "$QUERY" DIR/arguments.py | head',
  ])('ambiguous and sensitive grep searches still require approval: %s', (template) => {
    const dir = fs.realpathSync(makeTempDir());
    fs.writeFileSync(path.join(dir, 'one.py'), 'TODO\n');
    fs.writeFileSync(path.join(dir, 'one.txt'), 'TODO\n');
    fs.mkdirSync(path.join(dir, 'directory.PY'));
    fs.symlinkSync(dir, path.join(dir, 'alias'));
    fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'broken.py'));
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'secret.txt'));
    expect(evaluate(template.replaceAll('DIR', dir))).toMatchObject({
      pinned: true,
      decision: 'required',
    });
  });

  test('a direct search can report a missing file without requesting walk approval', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'model.py'), 'init\n');
    const batch = (flags: string) =>
      `grep -n init ${dir}/model.py | sed -n '1,60p'; echo ===; grep ${flags} 'unconstrain\\|init' ${dir}/services.py 2>/dev/null | head`;

    expect(evaluate(batch('-rn'))).toMatchObject({
      actionKey: 'bash:recursive-read',
      decision: 'required',
    });
    expect(evaluate(batch('-n'))).toMatchObject({
      pinned: false,
      decision: 'approved_fullauto',
    });

    fs.writeFileSync(path.join(dir, 'services.py'), 'init\n');
    expect(evaluate(batch('-rn'))).toMatchObject({ pinned: false });
  });

  test.each(['grep -rn', 'rg --hidden'])(
    'checks redirects separately from operands after --: %s',
    (prefix) => {
      const dir = makeTempDir();
      const file = path.join(dir, 'file.py');
      fs.writeFileSync(file, 'init\n');
      expect(evaluate(`${prefix} -- init ${file} 2> /dev/null`).pinned).toBe(
        false,
      );
      expect(evaluate(`${prefix} -- init ${file} < .env`)).toMatchObject({
        pinned: true,
        decision: 'required',
      });
    },
  );

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
