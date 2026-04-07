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
