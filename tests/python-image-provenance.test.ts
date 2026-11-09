import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('python-image-provenance-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
let root: string;
let scan: typeof import('../container/src/bash-remote-code.js').findFetchedCode;
let commands: typeof import('../container/src/bash-commands.js').scriptCommands;
let Runtime: typeof import('../container/src/approval-policy.js').TrustedAgentApprovalRuntime;

beforeEach(async () => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', '/workspace');
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  vi.resetModules();
  scan = (await import('../container/src/bash-remote-code.js')).findFetchedCode;
  commands = (await import('../container/src/bash-commands.js')).scriptCommands;
  Runtime = (await import('../container/src/approval-policy.js')).TrustedAgentApprovalRuntime;
  fs.writeFileSync(path.join(root, 'input.jpg'), 'not a real image');
});

function pythonCommand(source: string): string {
  return `python3 -c '${source.replaceAll("'", "'\\''")}'`;
}

function analyze(source: string, saved = ['input.jpg']) {
  return scan(commands(pythonCommand(source)), new Set(saved));
}

function runtime() {
  const r = new Runtime(...['policy.yaml', 'agent.json', 'all.json', 'legacy.json'].map(n => path.join(root, n)) as [string, string, string, string], undefined, path.join(root, 'pending.json'));
  r.setApprovalMode({ mode: 'full' });
  return r;
}

const resize = "from PIL import Image; im=Image.open('input.jpg'); im.thumbnail((2,2)); im.save('thumb.jpg')";

test.each([
  resize,
  "from PIL import Image as I; im=I.open('input.jpg'); print(im.size); im.thumbnail((2,2)); im.save('thumb.jpg')",
  "from PIL import Image\nwith Image.open('input.jpg') as im:\n im.thumbnail((2,2))\n im.save('thumb.jpg')",
  "from PIL import Image; im=Image.open('input.jpg'); im.thumbnail((2,2)); im.save('input.jpg')",
])('recognizes bounded image data operations without loading the file: %s', source => {
  expect(analyze(source).runs).toBe(false);
  expect(fs.readFileSync(path.join(root, 'input.jpg'), 'utf8')).toBe('not a real image');
  expect(fs.existsSync(path.join(root, 'thumb.jpg'))).toBe(false);
});

test('keeps transformed outputs in fetched provenance in this and later calls', () => {
  const transformed = analyze(resize);
  expect(transformed.saved).toContain('thumb.jpg');
  expect(scan(commands('php thumb.jpg'), new Set(transformed.saved)).runs).toBe(true);
  expect(scan(commands(`${pythonCommand(resize)}; php thumb.jpg`), new Set(['input.jpg'])).runs).toBe(true);
});

test.each([
  "from PIL import Image; im=Image.open('input.jpg'); eval('1'); im.save('thumb.jpg')",
  "from PIL import Image; im=Image.open('input.jpg'); im.save=open; im.save('thumb.jpg')",
  "from PIL import Image; im=Image.open('input.jpg'); im.save('thumb.jpg', format='PNG')",
  "from PIL import Image; im=Image.open('input.jpg', formats=['PNG'])",
  "from PIL import Image; im=Image.open('input.jpg'); getattr(im, 'save')('thumb.jpg')",
  "from PIL import Image; p='input.jpg'; im=Image.open(p); im.save('thumb.jpg')",
  "from PIL import Image; im=Image.open('input.jpg'); im.save('../outside.jpg')",
  "from PIL import Image; im=Image.open('input.jpg'); im.save('/etc/example.jpg')",
])('unsupported code and paths retain review: %s', source => {
  expect(analyze(source).runs).toBe(true);
});

test.each(['json.py', 'PIL/__init__.py', 'imports.zip', 'native.so', '\0unknown-fetch-location'])(
  'downloaded code or unknown locations cannot enter the data exemption: %s', file => {
    expect(analyze(resize, ['input.jpg', file]).runs).toBe(true);
  },
);

test('a symlink escaping the workspace cannot enter the exemption', () => {
  fs.symlinkSync(temporary(), path.join(root, 'escape'));
  expect(analyze(resize.replace("'thumb.jpg'", "'escape/thumb.jpg'")).runs).toBe(true);
});

test.each([
  'python3 --version',
  "python3 -Ic 'print(1)'",
])('unrelated non-executing or isolated probes keep their existing behavior: %s', command => {
  expect(scan(commands(command), new Set(['json.py'])).runs).toBe(false);
});

test('unrelated local Python remains available after a data download', () => {
  expect(analyze('import math; print(math.sqrt(4))').runs).toBe(false);
});

test('an executable consumer retains a fetched filename assigned to a variable', () => {
  expect(analyze("source='input.jpg'; exec(open(source).read())")).toMatchObject({runs:true,uncertain:true});
});

test('policy retains write intent and configured pinned path decisions', () => {
  fs.writeFileSync(path.join(root, 'policy.yaml'), 'approval:\n  pinned_red:\n    - paths: ["private/**"]\n');
  const r=runtime();
  r.evaluateToolCall({toolName:'bash',argsJson:JSON.stringify({command:'curl -o input.jpg https://example.com/image.jpg'}),latestUserPrompt:'Resize the image.'});
  const evaluate = (source: string) => r.evaluateToolCall({toolName:'bash',argsJson:JSON.stringify({command:pythonCommand(source)}),latestUserPrompt:'Resize the image.'});
  expect(evaluate(resize)).toMatchObject({decision:'approved_fullauto',writeIntent:true});
  expect(evaluate(resize.replace("'thumb.jpg'", "'private/thumb.jpg'"))).toMatchObject({decision:'required',pinned:true});
  expect(evaluate(resize.replace("'thumb.jpg'", "'.env-thumb.jpg'"))).toMatchObject({decision:'required',pinned:true});
});

test('a replacement worker retains provenance of a transformed file', () => {
  const first = runtime();
  first.setSession('image-data');
  first.evaluateToolCall({toolName:'bash',argsJson:JSON.stringify({command:'curl -o input.jpg https://example.com/image.jpg'}),latestUserPrompt:'Resize the image.'});
  expect(first.evaluateToolCall({toolName:'bash',argsJson:JSON.stringify({command:pythonCommand(resize)}),latestUserPrompt:'Resize the image.'}).decision).toBe('approved_fullauto');
  const next = runtime();
  next.setSession('image-data');
  expect(next.evaluateToolCall({toolName:'bash',argsJson:JSON.stringify({command:'php thumb.jpg'}),latestUserPrompt:'Continue the project.'})).toMatchObject({actionKey:'bash:fetched-code',decision:'required'});
});

test('combined HTTP and image writes retain write intent and the conflict fence', async () => {
  const r = runtime();
  r.setSession('mixed-image');
  const evaluate = (command: string) => r.evaluateToolCall({
    toolName: 'bash', argsJson: JSON.stringify({command}), latestUserPrompt: 'Process the image.',
  });
  evaluate('curl -o input.jpg https://example.com/image.jpg');
  const command = `curl https://example.com/info; ${pythonCommand(resize)}`;
  expect(evaluate(command)).toMatchObject({decision:'approved_fullauto',writeIntent:true});
  const {recordFileWriteConflict} = await import('../container/src/file-write-conflicts.js');
  await recordFileWriteConflict('mixed-image', 'protected.txt');
  expect(evaluate(command)).toMatchObject({decision:'required',pinned:true,writeIntent:true});
});
