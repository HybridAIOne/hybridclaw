import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

function currentLocalDateStamp(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe.sequential('container memory tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('blocks direct MEMORY.md writes and points callers to dream consolidation', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'memory',
      JSON.stringify({
        action: 'append',
        file_path: 'MEMORY.md',
        content: '- Durable fact.',
      }),
    );

    expect(result).toContain(
      "memory write actions are restricted to today's daily note",
    );
    expect(result).toContain('Use MEMORY.md only through dream consolidation.');
    expect(fs.existsSync(path.join(workspaceRoot, 'MEMORY.md'))).toBe(false);
  });

  test("allows writing to today's daily memory file", async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);

    const todayRelativePath = `memory/${currentLocalDateStamp()}.md`;
    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'memory',
      JSON.stringify({
        action: 'append',
        file_path: todayRelativePath,
        content: '- Durable fact.',
      }),
    );

    expect(result).toContain(`Appended 15 chars to ${todayRelativePath}`);
    expect(
      fs.readFileSync(path.join(workspaceRoot, todayRelativePath), 'utf-8'),
    ).toContain('- Durable fact.');
  });

  test('concurrent appends keep every note and release locks after validation failures', async () => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-appends-'));
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    const { executeTool } = await import('../container/src/tools.js');
    const file_path = `memory/${currentLocalDateStamp()}.md`;
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      executeTool('memory', JSON.stringify({ action: 'append', file_path, content: `entry ${index}` }))));
    expect(results.every(result => result.includes('Appended'))).toBe(true);
    const content = fs.readFileSync(path.join(workspaceRoot, file_path), 'utf8');
    for (let index = 0; index < 5; index++) expect(content).toContain(`entry ${index}`);
    const failure = await executeTool('memory', JSON.stringify({ action: 'append', file_path, content: 'x'.repeat(24_000) }));
    expect(failure).toContain('would exceed');
    expect(fs.existsSync(path.join(workspaceRoot, `${file_path}.lock`))).toBe(false);
    expect(fs.readFileSync(path.join(workspaceRoot, file_path), 'utf8')).toBe(content);
  });

  test('defaults writes to today and requires explicit overwrite confirmation', async () => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-defaults-'));
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    const { executeTool } = await import('../container/src/tools.js');
    const file = path.join(workspaceRoot, `memory/${currentLocalDateStamp()}.md`);
    expect(await executeTool('memory', JSON.stringify({ action: 'append', content: 'keep me' }))).toContain('Appended');
    for (const confirm_overwrite of [undefined, false, 'true']) {
      expect(await executeTool('memory', JSON.stringify({ action: 'write', content: 'replacement', confirm_overwrite }))).toContain('confirm_overwrite=true');
      expect(fs.readFileSync(file, 'utf8')).toContain('keep me');
    }
    expect(await executeTool('memory', JSON.stringify({ action: 'write', content: 'replacement', confirm_overwrite: true }))).toContain('Wrote');
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
    expect(await executeTool('memory', JSON.stringify({ action: 'append', file_path: '../escape.md', content: 'bad' }))).toContain('Error:');
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });

  test('memoizes USER.md timezone reads while the file is unchanged', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    fs.writeFileSync(
      path.join(workspaceRoot, 'USER.md'),
      '# USER.md\n\n- **Timezone:** Europe/Berlin\n',
      'utf-8',
    );

    const { executeTool } = await import('../container/src/tools.js');
    const userPath = path.join(workspaceRoot, 'USER.md');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    await executeTool(
      'memory',
      JSON.stringify({
        action: 'append',
        file_path: 'MEMORY.md',
        content: '- Durable fact.',
      }),
    );
    await executeTool(
      'memory',
      JSON.stringify({
        action: 'append',
        file_path: 'MEMORY.md',
        content: '- Another durable fact.',
      }),
    );

    expect(
      readSpy.mock.calls.filter(([filePath]) => filePath === userPath),
    ).toHaveLength(1);
  });
});
