import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  executeTool,
  setGatewayContext,
  setSessionContext,
  TOOL_DEFINITIONS,
} from '../container/src/tools.js';

const GATEWAY_URL = 'http://gateway.test';
const ORIGINAL_FETCH = globalThis.fetch;

type FetchCall = { url: string; init: RequestInit };

function installGatewayFetch(
  respond: (call: FetchCall) => { status?: number; body: unknown } | Error = () => ({
    body: { ok: true, deduplicated: false, draft: { id: 'fbd_0123456789' } },
  }),
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const outcome = respond(call);
    if (outcome instanceof Error) throw outcome;
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

const VALID_ARGS = {
  type: 'bug',
  title: 'web_fetch returned an empty body for a reachable page',
  details:
    "**What happened:** web_fetch returned 0 bytes for a page curl fetches fine.\n**What the user said:** User didn't comment; observed by the model.\n**Repro:** web_fetch https://example.com/page",
  area: 'web_fetch',
  trigger: 'tool_error',
  task_category: 'search',
};

describe.sequential('container report_feedback tool', () => {
  beforeEach(() => {
    setGatewayContext(
      GATEWAY_URL,
      'gateway-token',
      'channel-1',
      undefined,
      undefined,
      'agent:main:channel:web:chat:dm:peer:u1',
      'main',
    );
    setSessionContext('agent:main:channel:web:chat:dm:peer:u1');
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    setGatewayContext(undefined, undefined, '');
    setSessionContext('');
  });

  test('is registered with the shared enums in its schema', () => {
    const tool = TOOL_DEFINITIONS.find(
      (entry) => entry.type === 'function' && entry.function.name === 'report_feedback',
    );
    expect(tool).toBeDefined();
    const properties = (tool?.function.parameters as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(properties.type.enum).toEqual(['bug', 'idea', 'missing_capability']);
    expect(properties.trigger.enum).toContain('model_judgment');
    expect(properties.failure_mode.enum).toContain('instruction_following');
    expect((tool?.function.parameters as { required: string[] }).required).toEqual([
      'type',
      'title',
      'details',
    ]);
    expect(tool?.function.description).toContain('never sent without an operator');
  });

  test('posts the validated draft to the gateway callback with session context', async () => {
    const calls = installGatewayFetch();
    const result = await executeTool('report_feedback', JSON.stringify(VALID_ARGS));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${GATEWAY_URL}/api/feedback/draft`);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer gateway-token',
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.sessionId).toBe('agent:main:channel:web:chat:dm:peer:u1');
    expect(body.channelId).toBe('channel-1');
    expect(body.agentId).toBe('main');
    expect(body.draft).toMatchObject({
      type: 'bug',
      title: VALID_ARGS.title,
      trigger: 'tool_error',
      area: 'web_fetch',
      task_category: 'search',
    });

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.draftId).toBe('fbd_0123456789');
    expect(String(parsed.message)).toContain('/feedback send fbd_0123456789');
  });

  test('rejects invalid arguments before contacting the gateway', async () => {
    const calls = installGatewayFetch();
    const result = await executeTool(
      'report_feedback',
      JSON.stringify({ ...VALID_ARGS, type: 'complaint' }),
    );
    expect(result).toContain('`type` must be one of');
    expect(calls).toHaveLength(0);

    const missingDetails = await executeTool(
      'report_feedback',
      JSON.stringify({ type: 'idea', title: 'x' }),
    );
    expect(missingDetails).toContain('`details` is required');
  });

  test('surfaces gateway refusals to the model', async () => {
    installGatewayFetch(() => ({
      status: 403,
      body: { error: 'Feedback drafts are disabled.' },
    }));
    const result = await executeTool('report_feedback', JSON.stringify(VALID_ARGS));
    expect(result).toContain('HTTP 403');
    expect(result).toContain('Feedback drafts are disabled.');
  });
});
