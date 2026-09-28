import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import {
  executeTool,
  getPendingSideEffects,
  resetSideEffects,
  setGatewayContext,
} from '../container/src/tools.js';

async function withGateway(
  respond: (body: string) => { status: number; payload: unknown },
  run: (baseUrl: string) => Promise<void>,
): Promise<Array<{ url?: string; body: string }>> {
  const requests: Array<{ url?: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ url: req.url, body });
      const { status, payload } = respond(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return requests;
}

describe.sequential('container delegate tool', () => {
  afterEach(() => {
    resetSideEffects();
    setGatewayContext(undefined, undefined, undefined, undefined);
  });

  test('background chain mode queues a side effect and ignores redundant tasks', async () => {
    const payload = {
      background: true,
      mode: 'chain',
      label: 'invoice-pptx-workflow',
      model: 'openai-codex/gpt-5.4',
      tasks: [
        {
          prompt: 'analyze invoices',
          label: 'analyze',
        },
      ],
      chain: [
        {
          prompt: 'analyze invoices',
          label: 'analyze',
        },
        {
          prompt: 'build deck from {previous}',
          label: 'build',
        },
      ],
    };

    const result = await executeTool('delegate', JSON.stringify(payload));

    expect(result).toContain('Delegation accepted in the background (chain');
    const sideEffects = getPendingSideEffects();
    expect(sideEffects?.delegations).toEqual([
      {
        action: 'delegate',
        mode: 'chain',
        label: 'invoice-pptx-workflow',
        model: 'openai-codex/gpt-5.4',
        chain: [
          {
            prompt: 'analyze invoices',
            label: 'analyze',
            model: 'openai-codex/gpt-5.4',
          },
          {
            prompt: 'build deck from {previous}',
            label: 'build',
            model: 'openai-codex/gpt-5.4',
          },
        ],
      },
    ]);
  });

  test('waits for the gateway by default and returns the reports', async () => {
    let result = '';
    const requests = await withGateway(
      () => ({ status: 200, payload: { ok: true, result: 'child report' } }),
      async (baseUrl) => {
        setGatewayContext(baseUrl, 'token-123', 'web', []);
        result = await executeTool(
          'delegate',
          JSON.stringify({ prompt: 'check the logs', label: 'logs' }),
        );
      },
    );

    expect(result).toBe('child report');
    expect(getPendingSideEffects()).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/delegate');
    expect(JSON.parse(requests[0].body)).toEqual({
      sessionId: '',
      effect: {
        action: 'delegate',
        mode: 'single',
        prompt: 'check the logs',
        label: 'logs',
      },
    });
  });

  test('a waiting call surfaces gateway errors as a failed tool call', async () => {
    let result = '';
    await withGateway(
      () => ({ status: 400, payload: { error: 'depth limit reached' } }),
      async (baseUrl) => {
        setGatewayContext(baseUrl, 'token-123', 'web', []);
        result = await executeTool(
          'delegate',
          JSON.stringify({ prompt: 'check the logs' }),
        );
      },
    );

    expect(result).toBe('Error: delegation failed: depth limit reached');
  });

  test('the per-turn limit counts waiting and background calls', async () => {
    await withGateway(
      () => ({ status: 200, payload: { ok: true, result: 'done' } }),
      async (baseUrl) => {
        setGatewayContext(baseUrl, 'token-123', 'web', []);
        await executeTool('delegate', JSON.stringify({ prompt: 'one' }));
        await executeTool('delegate', JSON.stringify({ prompt: 'two' }));
        await executeTool(
          'delegate',
          JSON.stringify({ prompt: 'three', background: true }),
        );
        const fourth = await executeTool(
          'delegate',
          JSON.stringify({ prompt: 'four', background: true }),
        );
        expect(fourth).toBe('Error: delegation limit reached for this turn (3).');
      },
    );
  });
});
