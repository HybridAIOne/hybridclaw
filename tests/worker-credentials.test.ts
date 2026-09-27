import { describe, expect, test } from 'vitest';
import { SHELL_RUNTIME_ENV_PATH } from '../container/shared/shell-runtime-env.js';
import {
  bindWorkerCredentialSession,
  bindWorkerRequestBody,
  isWorkerRuntimeRoute,
  issueWorkerCredential,
  resolveWorkerCredential,
  revokeWorkerCredential,
} from '../src/security/worker-credentials.ts';

const WORKER_A = { agentId: 'agent-a', sessionId: 'session-a' };

// Routes whose body `sessionId` names the calling session.
const CALLER_SESSION_ROUTES = [
  '/api/http/request',
  '/api/secret/inject',
  '/api/browser/tool',
  '/api/message/action',
  '/api/plugin/tool',
  '/api/scheduler/task',
];

function statusOf(run: () => unknown): number | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
}

describe('worker credential registry', () => {
  test('resolves an issued credential until it is revoked', () => {
    const token = issueWorkerCredential(WORKER_A);

    expect(token).toMatch(/^hcw_[A-Za-z0-9_-]{43}$/);
    expect(resolveWorkerCredential(token)).toEqual(WORKER_A);
    expect(issueWorkerCredential(WORKER_A)).not.toBe(token);

    revokeWorkerCredential(token);
    expect(resolveWorkerCredential(token)).toBeNull();
  });

  test.each([
    ['an unknown worker token', `hcw_${'x'.repeat(43)}`],
    ['a gateway token', 'gateway-token'],
    ['a scoped API token', 'hck_0123456789ab_secret'],
    ['an empty bearer', ''],
  ])('does not resolve %s', (_label, token) => {
    expect(resolveWorkerCredential(token)).toBeNull();
  });

  test('binds a warm worker to the session that claims it, once', () => {
    const token = issueWorkerCredential({
      agentId: 'agent-a',
      sessionId: null,
    });

    bindWorkerCredentialSession(token, 'session-a');
    expect(resolveWorkerCredential(token)).toEqual(WORKER_A);
    bindWorkerCredentialSession(token, 'session-a');
    expect(() => bindWorkerCredentialSession(token, 'session-b')).toThrow(
      /another session/,
    );
    expect(resolveWorkerCredential(token)).toEqual(WORKER_A);
  });
});

describe('worker runtime routes', () => {
  test.each([
    ...CALLER_SESSION_ROUTES,
    '/api/interactive-escalations',
    '/api/interactive-escalations/consume',
    SHELL_RUNTIME_ENV_PATH,
  ])('POST %s is a runtime route', (pathname) => {
    expect(isWorkerRuntimeRoute('POST', pathname)).toBe(true);
  });

  test.each([
    ['PUT', '/api/admin/policy'],
    ['DELETE', '/api/admin/policy'],
    ['GET', '/api/admin/approvals'],
    ['PUT', '/api/admin/config'],
    ['POST', '/api/admin/config/reload'],
    ['PUT', '/api/admin/secrets/EXAMPLE_KEY'],
    ['POST', '/api/admin/tokens'],
    ['PUT', '/api/admin/scheduler'],
    ['POST', '/api/admin/restart'],
    ['POST', '/api/command'],
    ['POST', '/api/chat'],
    ['GET', '/api/history'],
    ['GET', '/api/events'],
    ['GET', '/api/interactive-escalations'],
    ['POST', '/api/interactive-escalations/resume'],
    ['POST', '/api/media/upload'],
    ['POST', '/api/discord/action'],
    ['GET', '/api/http/request'],
    ['POST', '/api/http/request/'],
    ['POST', '/v1/chat/completions'],
  ])('%s %s is not a runtime route', (method, pathname) => {
    expect(isWorkerRuntimeRoute(method, pathname)).toBe(false);
  });
});

describe('bindWorkerRequestBody', () => {
  test('passes bodies through unchanged without a worker credential', () => {
    const body = { agentId: 'agent-b', sessionId: 'session-b' };

    expect(bindWorkerRequestBody(body, null, 'POST', '/api/http/request')).toBe(
      body,
    );
  });

  test.each(CALLER_SESSION_ROUTES)(
    'POST %s acts as the credential agent and session',
    (pathname) => {
      expect(
        bindWorkerRequestBody({ url: 'x' }, WORKER_A, 'POST', pathname),
      ).toEqual({ url: 'x', ...WORKER_A });
      expect(
        bindWorkerRequestBody({ ...WORKER_A }, WORKER_A, 'POST', pathname),
      ).toEqual(WORKER_A);
      expect(
        statusOf(() =>
          bindWorkerRequestBody(
            { agentId: 'agent-b' },
            WORKER_A,
            'POST',
            pathname,
          ),
        ),
      ).toBe(403);
      expect(
        statusOf(() =>
          bindWorkerRequestBody(
            { sessionId: 'session-b' },
            WORKER_A,
            'POST',
            pathname,
          ),
        ),
      ).toBe(403);
      expect(
        statusOf(() =>
          bindWorkerRequestBody(
            {},
            { agentId: 'agent-a', sessionId: null },
            'POST',
            pathname,
          ),
        ),
      ).toBe(403);
    },
  );

  test('escalation ids stay gateway-assigned and ownership stays agent-bound', () => {
    const create = '/api/interactive-escalations';
    const consume = '/api/interactive-escalations/consume';

    expect(
      bindWorkerRequestBody({ prompt: 'code?' }, WORKER_A, 'POST', create),
    ).toEqual({ prompt: 'code?', agentId: 'agent-a' });
    for (const field of ['sessionId', 'approvalId']) {
      expect(
        statusOf(() =>
          bindWorkerRequestBody({ [field]: 'x' }, WORKER_A, 'POST', create),
        ),
      ).toBe(403);
    }
    expect(
      bindWorkerRequestBody(
        { sessionId: 'escalation-1' },
        WORKER_A,
        'POST',
        consume,
      ),
    ).toEqual({ sessionId: 'escalation-1', agentId: 'agent-a' });
    expect(
      statusOf(() =>
        bindWorkerRequestBody({ agentId: 'agent-b' }, WORKER_A, 'POST', create),
      ),
    ).toBe(403);
  });

  test.each([
    ['an array', []],
    ['a string', 'x'],
    ['null', null],
  ])('rejects %s as a worker body', (_label, body) => {
    expect(
      statusOf(() =>
        bindWorkerRequestBody(body, WORKER_A, 'POST', '/api/http/request'),
      ),
    ).toBe(400);
  });

  test('refuses to bind a body for a route outside the runtime routes', () => {
    expect(
      statusOf(() =>
        bindWorkerRequestBody({}, WORKER_A, 'PUT', '/api/admin/policy'),
      ),
    ).toBe(403);
  });
});
