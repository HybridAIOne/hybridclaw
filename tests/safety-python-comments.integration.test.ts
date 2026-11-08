import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test.each([false, true])(
  'a real worker distinguishes a comment from executable eval (blocked=%s)',
  async (blocked) => {
    const body = blocked
      ? "eval(\"open('unexpected.txt', 'w').write('executed')\")"
      : "print('parsed data')";
    const command = `python3 <<'PY'\n# eval summary\n${body}\nPY`;
    const run = await runAgent(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'python-stdin',
              type: 'function',
              function: { name: 'bash', arguments: JSON.stringify({ command }) },
            },
          ],
        },
        { role: 'assistant', content: 'Finished.' },
      ],
      { approvalMode: 'full' },
    );
    expect(run.output.pendingApproval).toBeUndefined();
    expect(fs.existsSync(path.join(run.dir, 'unexpected.txt'))).toBe(false);
    const execution = run.output.toolExecutions?.[0];
    if (blocked) {
      expect(execution).toMatchObject({ blocked: true, approvalDecision: 'denied' });
    } else {
      expect(execution).toMatchObject({ name: 'bash', isError: false });
      expect(execution?.result).toContain('parsed data');
    }
  },
);
