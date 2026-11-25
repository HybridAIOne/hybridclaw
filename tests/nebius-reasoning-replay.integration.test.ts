import { validateToolHistory } from '@hybridclaw/shared/tool-history';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const model = 'nebius/example/model';
const reasoning = '\n opaque fixture reasoning\n\n';

test('reasoning survives a tool turn, gateway validation, and a fresh worker', async () => {
  const first = await run(
    [
      {
        role: 'assistant',
        content: null,
        reasoning_content: reasoning,
        tool_calls: [
          {
            id: 'read-note',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"notes.txt"}' },
          },
        ],
      },
      { role: 'assistant', content: 'Read it.' },
    ],
    {
      provider: 'nebius',
      model,
      isLocal: false,
      allowedTools: ['read'],
      approvalMode: 'full',
    },
    { 'notes.txt': 'synthetic note' },
  );
  expect(first.output.status).toBe('success');
  const replayed = first.requests[1].messages?.find(
    (message) => message.role === 'assistant',
  );
  expect(replayed).toHaveProperty('reasoning_content', reasoning);
  expect(replayed).not.toHaveProperty('provider_reasoning');
  const history = validateToolHistory(
    JSON.parse(JSON.stringify(first.output.toolHistory)),
  );
  expect(history[0].provider_reasoning).toEqual({
    provider: 'nebius',
    model,
    content: reasoning,
  });
  const restarted = await run([{ role: 'assistant', content: 'Continued.' }], {
    provider: 'nebius',
    model,
    isLocal: false,
    messages: [
      { role: 'user', content: 'Read the note.' },
      ...history,
      { role: 'user', content: 'Continue.' },
    ],
  });
  expect(restarted.output.status).toBe('success');
  expect(
    restarted.requests[0].messages?.find(
      (message) => message.role === 'assistant',
    ),
  ).toHaveProperty('reasoning_content', reasoning);
  const changed = await restarted.followup({
    provider: 'openrouter',
    model: 'openrouter/example/other',
    messages: [{ role: 'user', content: 'New model.' }, ...history],
  });
  expect(changed.status).toBe('success');
  expect(
    restarted.requests
      .at(-1)
      ?.messages?.find((message) => message.role === 'assistant'),
  ).not.toHaveProperty('reasoning_content');
});
