import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { resolveAdminRbacAction, isAdminActionAllowed } from '../src/security/admin-rbac.js';
import { AGENT_RUNTIME_TOKEN_CLAIMS } from '../src/security/agent-runtime-token.js';
const require = createRequire(import.meta.url);
const helper = require('../skills/shared-notes/notes.cjs') as { request: (args: string[], env: Record<string, string>, input: string) => { url: string; body: Record<string, unknown>; token: string; agent: string } };
const env = { HYBRIDCLAW_GATEWAY_URL: 'http://127.0.0.1:9090', HYBRIDCLAW_GATEWAY_TOKEN: 'test-runtime-key', HYBRIDCLAW_AGENT_ID: 'notes-agent' };
describe('shared notebook skill', () => {
  it('uses the worker gateway and identity for discovery and revision-bearing writes', () => {
    const list = helper.request(['list'], env, '');
    expect(list.url).toBe('http://127.0.0.1:9090/api/notes/runtime?agentId=notes-agent');
    expect(list.body).toEqual({ operation: 'list' });
    expect(helper.request(['read', 'scratchpad'], env, '').body).toEqual({ operation: 'read', id: 'scratchpad' });
    const body = { operation: 'save', id: 'scratchpad', revision: 'a'.repeat(64), content: '- [x] Milk\n' };
    expect(helper.request(['apply'], env, JSON.stringify(body)).body).toEqual(body);
    expect(helper.request(['apply'], env, JSON.stringify({ ...body, agentId: 'other' })).url).toBe(list.url);
  });
  it('fails without a worker identity or for an unknown operation', () => {
    expect(() => helper.request(['list'], {}, '')).toThrow('worker gateway');
    expect(() => helper.request(['apply'], env, '{"operation":"delete-all"}')).toThrow('write operation');
    expect(() => helper.request(['read'], env, '')).toThrow('page ID');
    expect(() => helper.request(['list'], { ...env, HYBRIDCLAW_GATEWAY_URL: 'https://user:pass@example.com' }, '')).toThrow('origin');
  });
  it('exposes one authenticated runtime callback without granting the operator API', () => {
    expect(resolveAdminRbacAction('/api/notes/runtime', 'POST')).toBe('agent.runtime');
    expect(resolveAdminRbacAction('/api/notes/runtime', 'GET')).toBe(null);
    expect(isAdminActionAllowed(AGENT_RUNTIME_TOKEN_CLAIMS, 'notes.write')).toBe(false);
  });
});
