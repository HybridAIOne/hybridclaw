import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container ask_questions tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  async function tools() {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-questions-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    return await import('../container/src/tools.js');
  }

  test('writes the questions under questions/ and returns them with the questions media type', async () => {
    const { executeToolWithMetadata, TOOL_DEFINITIONS } = await tools();

    const result = await executeToolWithMetadata(
      'ask_questions',
      JSON.stringify({
        questions: [
          {
            question: '  Which day suits  you? ',
            options: ['Friday', ' Saturday '],
          },
          {
            question: 'What should be on the menu?',
            options: ['Pasta', 'Salad', 'Soup'],
            multiple: true,
          },
        ],
      }),
    );
    const parsed = JSON.parse(result.output) as {
      path: string;
      artifacts: Array<{ path: string; filename: string; mimeType: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.path).toMatch(/^questions\/[0-9a-f]{8}\.json$/);
    expect(parsed.artifacts).toEqual([
      {
        path: parsed.path,
        filename: 'questions.json',
        mimeType: 'application/vnd.hybridai.questions+json',
      },
    ]);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(workspaceRoot, parsed.path), 'utf-8'),
      ),
    ).toEqual({
      questions: [
        { question: 'Which day suits you?', options: ['Friday', 'Saturday'] },
        {
          question: 'What should be on the menu?',
          options: ['Pasta', 'Salad', 'Soup'],
          multiple: true,
        },
      ],
    });
    expect(TOOL_DEFINITIONS.map((tool) => tool.function.name)).toContain(
      'ask_questions',
    );
  });

  test('refuses questions the card cannot show', async () => {
    const { executeToolWithMetadata } = await tools();
    const refused = async (questions: unknown) =>
      (
        await executeToolWithMetadata(
          'ask_questions',
          JSON.stringify({ questions }),
        )
      ).isError;
    const one = { question: 'Which day?', options: ['Friday', 'Saturday'] };

    expect(await refused([])).toBe(true);
    expect(await refused([one, one, one, one, one])).toBe(true);
    expect(await refused([{ ...one, options: ['Friday'] }])).toBe(true);
    expect(await refused([{ ...one, options: ['Friday', 'Friday '] }])).toBe(
      true,
    );
    expect(await refused([{ ...one, question: ' ' }])).toBe(true);
    expect(await refused([{ ...one, options: ['Friday', 'x'.repeat(81)] }])).toBe(
      true,
    );
    expect(fs.existsSync(path.join(workspaceRoot, 'questions'))).toBe(false);
  });
});
