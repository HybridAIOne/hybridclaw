import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test.each([false, true])(
  'a real worker distinguishes activation from appended eval (blocked=%s)',
  async (blocked) => {
    let command = '';
    let calls = 0;
    const run = await runAgent(
      async () =>
        calls++ === 0
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'activation',
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
      { conda: '#!/bin/sh\nprintf "activated %s %s\\n" "$1" "$2"\n' },
      {
        prepare: async (dir) => {
          fs.chmodSync(path.join(dir, 'conda'), 0o755);
          command = `env PATH="${dir}:$PATH" conda activate eval`;
          if (blocked) command += ' && eval "printf marker > unexpected.txt"';
          return {};
        },
      },
    );
    expect(fs.existsSync(path.join(run.dir, 'unexpected.txt'))).toBe(false);
    expect(run.output.pendingApproval).toBeUndefined();
    const execution = run.output.toolExecutions?.[0];
    if (blocked) {
      expect(execution).toMatchObject({
        blocked: true,
        approvalDecision: 'denied',
      });
    } else {
      expect(execution).toMatchObject({ name: 'bash', isError: false });
      expect(execution?.result).toContain('activated activate eval');
    }
  },
);
