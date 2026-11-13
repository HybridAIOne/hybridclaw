import fs from 'node:fs';
import path from 'node:path';
import { DAILY_MEMORY_MAX_CHARS as LIMIT } from '@hybridclaw/shared/daily-memory';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('memory-capacity-');
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  restoreAllMocks: true,
});
let root: string;
let file: string;
const file_path = 'memory/2026-11-11.md';

beforeEach(() => {
  root = temporary();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', root);
  // Freeze the date without faking the lock's retry timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  fs.writeFileSync(path.join(root, 'USER.md'), '- **Timezone:** UTC\n');
  fs.mkdirSync(path.join(root, 'memory'));
  file = path.join(root, file_path);
});
useCleanMocks({ cleanup: () => vi.useRealTimers() });

async function memory(args: Record<string, unknown>) {
  const { executeToolWithMetadata, setSessionContext } = await import(
    '../container/src/tools.js'
  );
  setSessionContext('memory-capacity-test');
  return executeToolWithMetadata(
    'memory',
    JSON.stringify({ file_path, ...args }),
  );
}

function details(output: string) {
  return JSON.parse(output.slice(output.indexOf('\n') + 1));
}

function readCapacity(output: string) {
  const line = output.split('\n').find((line) => line.startsWith('Capacity: '));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice('Capacity: '.length));
}

test.each([
  { content: '', append: LIMIT - 1 },
  { content: 'note', append: LIMIT - 7 },
  { content: 'note\n\n ', append: LIMIT - 7 },
  { content: '😀', append: LIMIT - 5 },
  { content: 'x'.repeat(LIMIT), append: 0 },
  { content: 'x'.repeat(LIMIT + 1), append: 0 },
])(
  'daily reads report capacity for $content.length chars',
  async ({ content, append }) => {
    if (content) fs.writeFileSync(file, content);
    const result = await memory({ action: 'read' });
    expect(result.isError).toBe(false);
    expect(readCapacity(result.output)).toEqual({
      current_chars: content.length,
      limit_chars: LIMIT,
      remaining_chars: Math.max(0, LIMIT - content.length),
      append_capacity_chars: append,
    });
    expect(result.output).toContain(content || '(empty)');
    expect(fs.existsSync(file)).toBe(Boolean(content));
  },
);

test.each(['', 'existing\n\n '])(
  'append accepts the exact usable capacity after %j',
  async (existing) => {
    fs.writeFileSync(file, existing);
    const before = await memory({ action: 'read' });
    const { append_capacity_chars } = readCapacity(before.output);
    const result = await memory({
      action: 'append',
      content: 'n'.repeat(append_capacity_chars),
    });
    expect(result.isError).toBe(false);
    expect(readCapacity(result.output)).toMatchObject({
      current_chars: LIMIT,
      remaining_chars: 0,
      append_capacity_chars: 0,
    });
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(LIMIT);
  },
);

test.each([
  { action: 'append', content: 'y'.repeat(998) },
  { action: 'write', content: 'y'.repeat(LIMIT + 1), confirm_overwrite: true },
  { action: 'replace', old_text: 'x', new_text: 'y'.repeat(1002) },
])(
  'oversized $action reports recovery metadata without changing the note',
  async (args) => {
    const existing = 'x'.repeat(23_000);
    fs.writeFileSync(file, existing, { mode: 0o640 });
    const before = fs.statSync(file);
    const result = await memory(args);
    expect(result.isError).toBe(true);
    expect(details(result.output)).toMatchObject({
      code: 'MEMORY_CAPACITY_EXCEEDED',
      file_path,
      current_chars: 23_000,
      remaining_chars: 1000,
      append_capacity_chars: 997,
      attempted_chars: LIMIT + 1,
      overflow_chars: 1,
      next_actions: ['read', 'replace'],
      recovery: expect.any(String),
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(existing);
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  },
);

test('identical rejected payloads stay blocked across reads, alternate failures and replacement workers', async () => {
  const existing = 'x'.repeat(LIMIT - 5);
  fs.writeFileSync(file, existing);
  const args = { action: 'append', content: 'new fact' };
  expect(details((await memory(args)).output).code).toBe(
    'MEMORY_CAPACITY_EXCEEDED',
  );
  await memory({ action: 'read' });
  await memory({ action: 'append', content: 'a different fact' });
  vi.resetModules();
  // Path aliases and harmless outer whitespace identify the same effective mutation.
  const result = await memory({
    ...args,
    file_path: `/workspace/${file_path}`,
    content: ' new fact\n',
  });
  expect(result.isError).toBe(true);
  expect(details(result.output).code).toBe('MEMORY_RETRY_BLOCKED');
  expect(fs.readFileSync(file, 'utf8')).toBe(existing);
  const { sessionStatePath } = await import(
    '../container/src/session-state.js'
  );
  const stateDir = path.dirname(
    sessionStatePath('memory-capacity-test', 'unused'),
  );
  const records = fs
    .readdirSync(stateDir)
    .filter((name) => name.startsWith('memory-capacity-'));
  expect(records).toHaveLength(1);
  const saved = fs.readFileSync(path.join(stateDir, records[0]), 'utf8');
  expect(saved).not.toContain('new fact');
  expect(saved).not.toContain(existing);
});

test('safe targeted condensation makes the original append available again', async () => {
  const verbose = 'detail '.repeat(100);
  const unique = '\n- Keep this unique decision.\n';
  fs.writeFileSync(
    file,
    `${'x'.repeat(LIMIT - verbose.length - unique.length)}${verbose}${unique}`,
  );
  const args = { action: 'append', content: '- New durable fact.' };
  expect((await memory(args)).isError).toBe(true);
  const read = await memory({ action: 'read' });
  expect(read.output).toContain(verbose);
  const shortened = await memory({
    action: 'replace',
    old_text: verbose,
    new_text: 'detail',
  });
  expect(shortened.isError).toBe(false);
  expect(readCapacity(shortened.output).append_capacity_chars).toBeGreaterThan(
    args.content.length,
  );
  vi.resetModules();
  expect((await memory(args)).isError).toBe(false);
  const final = fs.readFileSync(file, 'utf8');
  expect(final).toContain(unique.trim());
  expect(final).toContain(args.content);
  expect(final.length).toBeLessThan(LIMIT);
});

test('a changed note revision invalidates old rejections even when it is still full', async () => {
  fs.writeFileSync(file, 'x'.repeat(LIMIT));
  const args = { action: 'append', content: 'new fact' };
  await memory(args);
  await memory({ action: 'append', content: 'another fact' });
  fs.writeFileSync(file, `y${'x'.repeat(LIMIT - 1)}`);
  expect(details((await memory(args)).output).code).toBe(
    'MEMORY_CAPACITY_EXCEEDED',
  );
  expect(details((await memory(args)).output).code).toBe(
    'MEMORY_RETRY_BLOCKED',
  );
  const { sessionStatePath } = await import(
    '../container/src/session-state.js'
  );
  const stateDir = path.dirname(
    sessionStatePath('memory-capacity-test', 'unused'),
  );
  const record = fs
    .readdirSync(stateDir)
    .find((name) => name.startsWith('memory-capacity-'))!;
  const saved = JSON.parse(
    fs.readFileSync(path.join(stateDir, record), 'utf8'),
  );
  expect(saved.values).toHaveLength(1);
});

test('a smaller payload can fit without modifying the existing note first', async () => {
  fs.writeFileSync(file, 'x'.repeat(LIMIT - 5));
  expect(
    (await memory({ action: 'append', content: 'too long' })).isError,
  ).toBe(true);
  expect((await memory({ action: 'append', content: 'ok' })).isError).toBe(
    false,
  );
  expect(fs.readFileSync(file, 'utf8')).toHaveLength(LIMIT);
});

test('explicit removal can shrink an externally oversized note without discarding other facts', async () => {
  const existing = `${'x'.repeat(LIMIT)} duplicate\nunique`;
  fs.writeFileSync(file, existing);
  const result = await memory({ action: 'remove', old_text: ' duplicate' });
  expect(result.isError).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(`${'x'.repeat(LIMIT)}\nunique`);
  expect(readCapacity(result.output)).toMatchObject({
    remaining_chars: 0,
    append_capacity_chars: 0,
  });
});

test('parallel identical failures record one rejection and block the other', async () => {
  const existing = 'x'.repeat(LIMIT);
  fs.writeFileSync(file, existing);
  const results = await Promise.all(
    Array.from({ length: 2 }, () =>
      memory({ action: 'append', content: 'fact' }),
    ),
  );
  expect(results.map((result) => details(result.output).code).sort()).toEqual([
    'MEMORY_CAPACITY_EXCEEDED',
    'MEMORY_RETRY_BLOCKED',
  ]);
  expect(fs.readFileSync(file, 'utf8')).toBe(existing);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test('unreadable retry history fails closed and releases the note lock', async () => {
  const existing = 'x'.repeat(LIMIT);
  fs.writeFileSync(file, existing);
  await memory({ action: 'append', content: 'fact' });
  const { sessionStatePath } = await import(
    '../container/src/session-state.js'
  );
  const stateDir = path.dirname(
    sessionStatePath('memory-capacity-test', 'unused'),
  );
  const record = fs
    .readdirSync(stateDir)
    .find((name) => name.startsWith('memory-capacity-'))!;
  fs.writeFileSync(path.join(stateDir, record), '{broken');
  vi.resetModules();
  expect((await memory({ action: 'append', content: 'fact' })).isError).toBe(
    true,
  );
  expect(fs.readFileSync(file, 'utf8')).toBe(existing);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});
