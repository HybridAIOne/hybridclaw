import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { validateToolHistory } from '@hybridclaw/shared/tool-history';
import type { ContainerInput } from '../container/src/types.js';
import { runContainerWorker } from './helpers/container-worker.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('local-call-identity-');
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Spec = {
  provider: 'vllm' | 'ollama';
  mode: 'structured' | 'text' | 'thinking' | 'answer';
  stream: boolean;
  id?: string;
  finish?: string;
  noMarker?: boolean;
  isLocal?: boolean;
  omitDone?: boolean;
  omitFinish?: boolean;
};
const args = { path: 'requested.txt', contents: 'Requested neutral sample.' };

async function run(spec: Spec) {
  const root = temp();
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    const first = requests.length === 1;
    const rawCall = {
      ...(spec.id ? { id: spec.id } : {}),
      type: 'function',
      function: {
        name: 'write',
        arguments: spec.provider === 'ollama' ? args : JSON.stringify(args),
      },
    };
    const markup = `<tool_call>${JSON.stringify({ name: 'write', arguments: args })}</tool_call>`;
    const message: {
      role: string;
      content: string | null;
      tool_calls?: (typeof rawCall)[];
      reasoning_content?: string;
    } = first
      ? spec.mode === 'answer'
        ? { role: 'assistant', content: 'Visible neutral response.' }
        : spec.mode === 'structured'
          ? { role: 'assistant', content: null, tool_calls: [rawCall] }
          : spec.mode === 'thinking'
            ? { role: 'assistant', content: null, reasoning_content: markup }
            : { role: 'assistant', content: markup }
      : { role: 'assistant', content: 'No further action is planned.' };
    const finish =
      first && spec.omitFinish
        ? undefined
        : first
          ? (spec.finish ?? 'stop')
          : 'stop';
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
    };
    if (spec.provider === 'ollama') {
      const payload = {
        model: 'sample-model',
        message,
        done: !(first && spec.noMarker),
        done_reason: first && spec.noMarker ? undefined : finish,
        prompt_eval_count: 100,
        eval_count: 25,
      };
      res.writeHead(200, {
        'Content-Type': spec.stream
          ? 'application/x-ndjson'
          : 'application/json',
      });
      res.end(
        spec.stream
          ? `${JSON.stringify({ model: 'sample-model', message, done: false, prompt_eval_count: 100, eval_count: 25 })}\n${first && spec.noMarker ? '' : `${JSON.stringify({ ...payload, message: { role: 'assistant', content: '' } })}\n`}`
          : JSON.stringify(payload),
      );
    } else {
      res.writeHead(200, {
        'Content-Type': spec.stream ? 'text/event-stream' : 'application/json',
      });
      res.end(
        spec.stream
          ? `data: ${JSON.stringify({ choices: [{ delta: { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) } }], usage })}\n\n${first && spec.noMarker ? '' : `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage })}\n\n${first && spec.omitDone ? '' : 'data: [DONE]\n\n'}`}`
          : JSON.stringify({
              choices: [{ message, finish_reason: finish }],
              usage,
            }),
      );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port.');
  const input: ContainerInput = {
    sessionId: 'call-identity',
    runId: 'run-a',
    provider: spec.provider,
    isLocal: spec.isLocal ?? true,
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'test-key',
    model: 'sample-model',
    chatbotId: '',
    enableRag: false,
    channelId: 'web',
    skipContainerSystemPrompt: true,
    approvalMode: 'full',
    allowedTools: ['write'],
    streamTextDeltas: spec.stream,
    modelBehavior: { thinkingFormat: 'qwen' },
    messages: [
      {
        role: 'user',
        content:
          spec.mode === 'answer'
            ? 'Describe the neutral sample.'
            : 'Write the requested neutral sample.',
      },
    ],
  };
  const output = await runContainerWorker(input, {
    HOME: root,
    HYBRIDCLAW_DATA_DIR: root,
    HYBRIDCLAW_AGENT_WORKSPACE_ROOT: root,
    HYBRIDCLAW_AGENT_STATE_ROOT: root,
  });
  return { output, requests, root };
}

const completed = (
  [
    { provider: 'vllm', mode: 'structured' },
    { provider: 'vllm', mode: 'text' },
    { provider: 'vllm', mode: 'thinking' },
    { provider: 'ollama', mode: 'structured' },
  ] satisfies Array<Pick<Spec, 'provider' | 'mode'>>
).flatMap((spec) => [false, true].map((stream) => ({ ...spec, stream })));

test.each(completed)(
  'an ID-less call completes with valid replay ($provider/$mode/$stream)',
  async (spec) => {
    const worker = await run(spec);
    expect(worker.output.status, worker.output.error).toBe('success');
    expect(fs.readFileSync(path.join(worker.root, args.path), 'utf8')).toBe(
      args.contents,
    );
    expect(worker.output.toolExecutions).toHaveLength(1);
    const id = worker.output.toolExecutions?.[0].toolCallId;
    expect(id).toEqual(expect.any(String));
    expect(id?.trim()).not.toBe('');
    expect(worker.output.toolHistory?.[0].tool_calls?.[0].id).toBe(id);
    expect(worker.output.toolHistory?.[1].tool_call_id).toBe(id);
    expect(() => validateToolHistory(worker.output.toolHistory)).not.toThrow();
    expect(worker.requests).toHaveLength(2);
    if (spec.provider === 'ollama')
      expect(
        worker.requests[1].messages.find((message) => message.role === 'tool')
          ?.tool_name,
      ).toBe('write');
  },
);

test.each(['vllm', 'ollama'] as const)(
  'an explicit ID is retained (%s)',
  async (provider) => {
    const worker = await run({
      provider,
      mode: 'structured',
      stream: false,
      id: 'kept-id',
    });
    expect(worker.output.status).toBe('success');
    expect(worker.output.toolExecutions?.[0].toolCallId).toBe('kept-id');
  },
);

test.each(
  (
    [
      { provider: 'vllm', finish: 'length' },
      { provider: 'vllm', finish: 'content_filter' },
      { provider: 'ollama', finish: 'length' },
    ] satisfies Array<Pick<Spec, 'provider' | 'finish'>>
  ).flatMap((spec) => [false, true].map((stream) => ({ ...spec, stream }))),
)(
  'an unfinished batch executes nothing ($provider/$finish/$stream)',
  async (spec) => {
    const worker = await run({ ...spec, mode: 'structured', id: 'unfinished' });
    expect(fs.existsSync(path.join(worker.root, args.path))).toBe(false);
    if (spec.finish === 'length') {
      expect(worker.output.status, worker.output.error).toBe('success');
      expect(worker.output.toolExecutions?.[0]).toMatchObject({
        blocked: true,
        isError: true,
        toolCallId: 'unfinished',
      });
      expect(worker.output.tokenUsage?.modelCalls).toBe(2);
      expect(worker.output.tokenUsage?.apiTotalTokens).toBe(250);
    } else {
      expect(worker.output.status).toBe('error');
      expect(worker.output.toolExecutions ?? []).toEqual([]);
      expect(worker.requests).toHaveLength(1);
      expect(worker.output.tokenUsage?.apiTotalTokens).toBe(125);
    }
  },
);

test.each([
  { provider: 'vllm', stream: true },
  { provider: 'ollama', stream: true },
  { provider: 'ollama', stream: false },
] as const)(
  'a reply without a completion marker retains usage and runs nothing ($provider/$stream)',
  async ({ provider, stream }) => {
    const worker = await run({
      provider,
      mode: 'structured',
      stream,
      id: 'unfinished',
      noMarker: true,
    });
    expect(worker.output.status).toBe('error');
    expect(fs.existsSync(path.join(worker.root, args.path))).toBe(false);
    expect(worker.output.toolExecutions ?? []).toEqual([]);
    expect(worker.requests).toHaveLength(1);
    expect(worker.output.tokenUsage?.apiTotalTokens).toBe(125);
  },
);

test.each([
  { provider: 'vllm', stream: true },
  { provider: 'ollama', stream: true },
  { provider: 'ollama', stream: false },
] as const)(
  'an incomplete visible answer is not a completion claim ($provider/$stream)',
  async ({ provider, stream }) => {
    const worker = await run({
      provider,
      stream,
      mode: 'answer',
      noMarker: true,
      isLocal: false,
    });
    expect(worker.output.status).toBe('error');
    expect(worker.output.result).toBeNull();
    expect(worker.output.tokenUsage?.apiTotalTokens).toBe(125);
    expect(worker.output.toolExecutions ?? []).toEqual([]);
    expect(worker.requests).toHaveLength(1);
  },
);

test.each(['vllm', 'ollama'] as const)(
  'ordinary completed answers remain available (%s)',
  async (provider) => {
    const worker = await run({ provider, stream: true, mode: 'answer' });
    expect(worker.output.status, worker.output.error).toBe('success');
    expect(worker.output.result).toBe('Visible neutral response.');
    expect(worker.output.toolExecutions ?? []).toEqual([]);
  },
);

test.each([
  { provider: 'vllm', stream: true, omitDone: true },
  { provider: 'vllm', stream: true, omitFinish: true },
  { provider: 'vllm', stream: false, omitFinish: true },
  { provider: 'ollama', stream: true, omitFinish: true },
] as const)(
  'complete framing preserves compatible calls ($provider/$stream)',
  async (spec) => {
    const worker = await run({ ...spec, mode: 'structured' });
    expect(worker.output.status, worker.output.error).toBe('success');
    expect(fs.readFileSync(path.join(worker.root, args.path), 'utf8')).toBe(
      args.contents,
    );
  },
);
