/** Network-free fixture for check-launcher.py; never copied into task images. */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    return originalFetch(input, init);
  assert.equal(
    url.origin,
    'https://openrouter.ai',
    'Fixture forbids external requests',
  );
  if (url.pathname.endsWith('/models'))
    return Response.json({
      data: [
        {
          id: 'z-ai/glm-5',
          context_length: 128000,
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          top_provider: { max_completion_tokens: 16000 },
          pricing: { prompt: '0', completion: '0' },
        },
      ],
    });
  assert.equal(url.pathname, '/api/v1/chat/completions');
  const body = JSON.parse(init.body);
  let message = { role: 'assistant', content: 'Fixture response' };
  let finish = 'stop';
  if (process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE === 'host') {
    const state = process.env.HYBRIDCLAW_AGENT_STATE_ROOT;
    assert.ok(state && state !== '/tmp_workspace');
    assert.ok(fs.existsSync(state + '/SOUL.md'));
    assert.equal(process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT, '/tmp_workspace');
    if (!fs.existsSync('/tmp_workspace/results/fixture.txt')) {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'fixture-write',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({
                path: 'results/fixture.txt',
                contents: 'Fixture artifact',
              }),
            },
          },
        ],
      };
      finish = 'tool_calls';
    }
  }
  return Response.json({
    id: 'gen-fixture-check',
    model: body.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
};
