import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test('quoted format query data passes authenticated worker dispatch', async () => {
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'query-data',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: `node -e 'require("node:fs").writeFileSync("fixture-output.txt", new URL("https://example.com/api?x=1&format=json").searchParams.get("format"))'`,
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'Fixture finished.' },
    ],
    { approvalMode: 'full' },
  );
  expect(worker.output.status).toBe('success');
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0].isError).toBe(false);
  expect(
    fs.readFileSync(path.join(worker.dir, 'fixture-output.txt'), 'utf8'),
  ).toBe('json');
});
