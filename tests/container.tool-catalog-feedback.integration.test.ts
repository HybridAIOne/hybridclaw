import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const catalog = (id: string, args: Record<string, unknown>) => ({
  id, type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify(args) },
});

test('a nested schema correction executes only the corrected batch with stable history and tools', async () => {
  let stage = 0;
  const worker = await run(async (body) => {
    if (stage++ === 0) return { role: 'assistant', content: null, tool_calls: [
      catalog('sibling', { action: 'call', name: 'read', arguments: { path: 'notes.txt' } }),
      catalog('bad', { action: 'call', name: 'write', arguments: { path: 'receipt.txt' }, contents: 'unsaved-input-value' }),
    ] };
    if (stage === 2) {
      return { role: 'assistant', content: null, tool_calls: [
        catalog('fixed', { action: 'call', name: 'write', arguments: { path: 'receipt.txt', contents: 'verified record' } }),
      ] };
    }
    return { role: 'assistant', content: 'Saved.' };
  }, { allowedTools: ['read', 'write'], localToolMode: 'starred', localStarterTools: [], approvalMode: 'full' }, { 'notes.txt': 'untouched' });
  expect(worker.output.status).toBe('success');
  expect(worker.requests).toHaveLength(3);
  const feedback = worker.requests[1].messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
  expect(feedback).toContain('tool_catalog.arguments');
  expect(feedback).toContain("required property 'contents'");
  expect(feedback).not.toContain('unsaved-input-value');
  expect(worker.output.toolExecutions?.filter(execution => !execution.isError).map(execution => execution.name)).toEqual(['write']);
  expect(fs.readFileSync(path.join(worker.dir, 'receipt.txt'), 'utf8')).toBe('verified record');
  expect(worker.requests[1].messages.slice(0, worker.requests[0].messages.length)).toEqual(worker.requests[0].messages);
  expect(worker.requests[1].tools).toEqual(worker.requests[0].tools);
});
