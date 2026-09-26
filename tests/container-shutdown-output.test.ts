import { expect, test } from 'vitest';
import { buildInterruptedShutdownOutput } from '../container/src/shutdown-output.js';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';

test('builds a structured interrupted output for signal shutdown', () => {
  expect(buildInterruptedShutdownOutput('SIGINT')).toEqual({
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error:
      'Request interrupted: the agent process received SIGINT before producing a final response.',
  });
});

test('carries pending delegation side effects through an interrupted shutdown', () => {
  const sideEffects = {
    delegations: [{ action: 'delegate' as const, prompt: 'summarize inbox' }],
  };

  expect(buildInterruptedShutdownOutput('SIGTERM', sideEffects)).toMatchObject({
    status: 'error',
    sideEffects,
  });
  expect(buildInterruptedShutdownOutput('SIGTERM', undefined)).not.toHaveProperty(
    'sideEffects',
  );
});

test('keeps the running turn’s tool calls, marking the open one as outcome unknown', () => {
  const turn = new TurnToolHistory('session-a');
  const call = (id: string, imagePath: string) => ({
    id,
    type: 'function' as const,
    function: {
      name: 'vision_analyze',
      arguments: JSON.stringify({ image_url: imagePath }),
    },
  });
  turn.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: [
      call('done', '/uploaded-media-cache/2026-09-26/1-a-Logo.png'),
      call('open', '/uploaded-media-cache/2026-09-26/2-b-Icon.png'),
    ],
  });
  turn.recordResult({
    role: 'tool',
    tool_call_id: 'done',
    content: 'A blue wordmark on white.',
  });

  const output = buildInterruptedShutdownOutput('SIGTERM', undefined, turn);

  expect(output).toMatchObject({ status: 'error', result: null });
  expect(output.toolHistory).toEqual(output.toolHistoryForReplay);
  expect(output.toolHistory?.[0].tool_calls?.[0].function.arguments).toContain(
    '/uploaded-media-cache/2026-09-26/1-a-Logo.png',
  );
  expect(output.toolHistory?.slice(1)).toEqual([
    { role: 'tool', tool_call_id: 'done', content: 'A blue wordmark on white.' },
    {
      role: 'tool',
      tool_call_id: 'open',
      content:
        'Tool outcome unknown: the agent process received SIGTERM before this call returned; it may not have run, or may have run partially.',
      is_error: true,
    },
  ]);
});

test('omits tool history when the interrupted turn had not called a tool', () => {
  const output = buildInterruptedShutdownOutput(
    'SIGTERM',
    undefined,
    new TurnToolHistory('session-a'),
  );
  expect(output).not.toHaveProperty('toolHistory');
  expect(output).not.toHaveProperty('toolHistoryForReplay');
});
