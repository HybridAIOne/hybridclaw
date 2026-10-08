import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ChatMessage, PendingApproval } from '../container/src/types.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();
// Must match tests/fixtures/boost-mcp-server.mjs.
const OFFER_ID = '0123456789abcdef0123456789abcdef';
const FALLBACK = 'Waiting for the user to choose whether to use a boost.';

interface LoggedCall {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// Full approval mode would run anything without asking; a boost still asks.
async function askForFox() {
  const run = await runContainerAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_fox',
            type: 'function',
            function: {
              name: 'hybridai__image_generate',
              arguments: JSON.stringify({ prompt: 'a red fox' }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'Here is your fox.' },
    ],
    {
      approvalMode: 'full',
      messages: [{ role: 'user', content: 'Draw a red fox' }],
    },
    {},
    {
      prepare: async (dir) => ({
        mcpServers: {
          hybridai: {
            transport: 'stdio',
            command: process.execPath,
            args: [
              path.resolve('tests/fixtures/boost-mcp-server.mjs'),
              path.join(dir, 'calls.jsonl'),
            ],
          },
        },
      }),
      timeoutMs: 20_000,
    },
  );
  const calls = (): LoggedCall[] =>
    fs
      .readFileSync(path.join(run.dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as LoggedCall);
  const answer = (text: string) =>
    run.followup({
      messages: [
        { role: 'user', content: 'Draw a red fox' },
        { role: 'assistant', content: run.output.result },
        { role: 'user', content: text },
      ] as ChatMessage[],
    });
  return { ...run, calls, answer };
}

test('a boost offer becomes the user’s question, never the model’s result', {
  timeout: 60_000,
}, async () => {
  const run = await askForFox();

  expect(run.calls()).toEqual([
    {
      name: 'image_generate',
      arguments: { prompt: 'a red fox' },
      _meta: { 'hybridai/boostOffers': true },
    },
  ]);
  expect(run.output.pendingApproval).toMatchObject({
    approvalId: OFFER_ID,
    toolName: 'hybridai__image_generate',
    allowSession: false,
    allowAgent: false,
    allowAll: false,
    boost: { category: 'image', modelName: 'Flux 2 Pro', available: 3 },
  });
  expect(run.output.toolExecutions?.at(-1)).toMatchObject({
    name: 'hybridai__image_generate',
    blocked: true,
    approvalDecision: 'required',
  });
  // The text stored as Hy's reply is read by the model later.
  expect(run.output.result).toContain('Use 1 boost (3 left) for Flux 2 Pro?');
  expect(run.output.result).not.toContain(OFFER_ID);
  expect(run.requests).toHaveLength(1);

  const streamed = run
    .stderr()
    .split('\n')
    .find((line) => line.startsWith('[approval] '));
  const event = JSON.parse(
    Buffer.from(streamed?.slice(11) ?? '', 'base64').toString('utf8'),
  ) as PendingApproval;
  expect(event).toMatchObject({
    approvalId: OFFER_ID,
    boost: { category: 'image', modelName: 'Flux 2 Pro', available: 3 },
  });

  const answered = await run.answer(`/boost use ${OFFER_ID}`);

  expect(run.calls()[1]).toEqual({
    name: 'image_generate',
    arguments: { prompt: 'a red fox' },
    _meta: {
      'hybridai/boostOffers': true,
      'hybridai/boost': { offer: OFFER_ID, use: true },
    },
  });
  expect(answered.result).toBe('Here is your fox.');
  expect(answered.pendingApproval).toBeUndefined();
  const seenByModel = JSON.stringify(run.requests);
  expect(seenByModel).toContain('Flux image ready');
  expect(seenByModel).not.toContain(OFFER_ID);
  expect(seenByModel).not.toContain(FALLBACK);
});

test('skipping, or a plain no, repeats the call without the boost', {
  timeout: 60_000,
}, async () => {
  for (const text of [`/boost skip ${OFFER_ID}`, 'no']) {
    const run = await askForFox();
    const answered = await run.answer(text);

    expect(run.calls()[1]._meta).toEqual({
      'hybridai/boostOffers': true,
      'hybridai/boost': { offer: OFFER_ID, use: false },
    });
    expect(answered.result).toBe('Here is your fox.');
    expect(JSON.stringify(run.requests.at(-1))).toContain(
      'Standard image ready',
    );
  }
});

test('an answer to a closed offer spends nothing and reaches no model', {
  timeout: 60_000,
}, async () => {
  const run = await askForFox();
  await run.answer(`/boost skip ${OFFER_ID}`);

  const again = await run.answer(`/boost use ${OFFER_ID}`);

  expect(again.result).toBe(
    'That boost offer is no longer open, so no boost was spent.',
  );
  expect(run.calls()).toHaveLength(2);
  expect(run.requests).toHaveLength(2);
});
