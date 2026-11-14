import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { toolResultFilePath } from '@hybridclaw/shared/tool-history';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('a real worker retains two results sharing a provider ID through normal IPC', async () => {
  const first = 'First neutral fixture.\n'.repeat(2_000);
  const second = 'Second neutral fixture.\n'.repeat(2_000);
  let replies = 0;
  const worker = await runAgent(
    async () => {
      if (replies >= 2) return { role: 'assistant', content: 'Finished.' };
      const file = replies++ === 0 ? 'first.txt' : 'second.txt';
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'reused',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: `cat ${file}` }),
            },
          },
        ],
      };
    },
    { allowedTools: ['bash'] },
    { 'first.txt': first, 'second.txt': second },
  );
  expect(worker.output.status).toBe('success');
  expect(worker.output.spilledToolCallIds).toEqual(['reused']);
  expect(
    worker.output.toolExecutions?.every(
      (entry) => typeof entry.resultDigest === 'string',
    ),
  ).toBe(true);
  const restored = restoreSpilledToolResults(worker.output, {
    sessionId: 'test-session',
    workspaceRoot: worker.dir,
  });
  const results = restored.toolExecutions?.map((entry) => entry.result);
  expect(results).toHaveLength(2);
  expect(results?.[0]).toContain('First neutral fixture.');
  expect(results?.[0]).not.toContain('Second neutral fixture.');
  expect(results?.[1]).toContain('Second neutral fixture.');
  expect(results).toEqual(
    restored.toolExecutions?.map((entry) =>
      fs.readFileSync(
        path.join(
          worker.dir,
          toolResultFilePath(
            'test-session',
            entry.toolCallId,
            entry.resultDigest!,
          ),
        ),
        'utf8',
      ),
    ),
  );
  expect(results?.[0]).not.toBe(results?.[1]);
  expect(
    fs.readdirSync(path.join(worker.dir, '.tool-results', 'test-session')),
  ).toHaveLength(2);
  for (const request of worker.requests)
    expect(JSON.stringify(request.messages)).not.toContain('resultDigest');
});
