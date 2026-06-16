import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container edit tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('accepts old_text and new_text aliases for model-generated edits', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-edit-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    const userPath = path.join(workspaceRoot, 'USER.md');
    fs.writeFileSync(
      userPath,
      [
        '# USER.md - About Your Human',
        '',
        '- **Timezone:**',
        '- **Primary work / activity:** Coder, creator of HybridClaw',
        '- **Organization / team:** HybridAI',
        '- **HybridClaw goals:** meeting deadlines, productivity, engineering workflows',
        '- **Important tools and platforms:** GitHub, Discord',
        '- **Preferred working style:**',
        '- **Boundaries and approvals:** ask before external, destructive, production, billing, or credential changes',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { executeTool } = await import('../container/src/tools.js');
    const result = await executeTool(
      'edit',
      JSON.stringify({
        path: 'USER.md',
        old_text:
          '- **Timezone:**\n- **Primary work / activity:** Coder, creator of HybridClaw\n- **Organization / team:** HybridAI\n- **HybridClaw goals:** meeting deadlines, productivity, engineering workflows\n- **Important tools and platforms:** GitHub, Discord\n- **Preferred working style:**',
        new_text:
          '- **Timezone:** CET/CEST (Berlin, UTC+1/+2)\n- **Primary work / activity:** Coder, creator of HybridClaw\n- **Organization / team:** HybridAI\n- **HybridClaw goals:** meeting deadlines, productivity, engineering workflows\n- **Important tools and platforms:** GitHub, Discord\n- **Preferred working style:** Caveman. Short. Blunt. No fluff. Direct calls to action.',
      }),
    );

    expect(result).toBe('Edited USER.md (1 replacement)');
    const updated = fs.readFileSync(userPath, 'utf-8');
    expect(updated).toContain(
      '- **Timezone:** CET/CEST (Berlin, UTC+1/+2)',
    );
    expect(updated).toContain(
      '- **Preferred working style:** Caveman. Short. Blunt. No fluff. Direct calls to action.',
    );
  });

  test('advertises old_text and new_text aliases in the edit schema', async () => {
    const { TOOL_DEFINITIONS } = await import('../container/src/tools.js');
    const editTool = TOOL_DEFINITIONS.find(
      (tool) => tool.function.name === 'edit',
    );

    expect(editTool?.function.parameters.properties).toMatchObject({
      old_text: { type: 'string' },
      new_text: { type: 'string' },
    });
  });
});
