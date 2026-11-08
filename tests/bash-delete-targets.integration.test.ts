import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test.each(
  ['rm', 'unlink', 'env -u FEATURE unlink'].flatMap((program) =>
    [true, false].map((outside) => ({ program, outside })),
  ),
)(
  'a real worker preserves the deletion boundary: $program outside=$outside',
  async ({ program, outside }) => {
    const target = outside
      ? '/opt/hybridclaw-policy-fixture-missing/notes.txt'
      : 'notes.txt';
    if (outside) expect(fs.existsSync(target)).toBe(false);
    let command = '';
    let requests = 0;
    const run = await runAgent(
      () =>
        ++requests === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'delete',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({ command }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Finished.' },
      { approvalMode: 'full' },
      { 'notes.txt': 'Disposable fixture' },
      {
        prepare: async (dir) => {
          const log = path.join(dir, 'cleanup.log').replaceAll("'", "'\\''");
          command = `${program} ${target} > '${log}' 2>&1`;
          return {};
        },
      },
    );
    if (outside) {
      expect(run.output.pendingApproval).toBeDefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({ blocked: true });
      expect(fs.existsSync(path.join(run.dir, 'cleanup.log'))).toBe(false);
      expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
        'Disposable fixture',
      );
    } else {
      expect(run.output.pendingApproval).toBeUndefined();
      expect(run.output.toolExecutions?.[0]).toMatchObject({
        blocked: false,
        isError: false,
      });
      expect(fs.existsSync(path.join(run.dir, 'notes.txt'))).toBe(false);
      expect(fs.existsSync(path.join(run.dir, 'cleanup.log'))).toBe(true);
    }
  },
);
