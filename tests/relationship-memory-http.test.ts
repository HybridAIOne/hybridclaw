import type { ServerResponse } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import { handleRelationshipMemoryRoute } from '../src/gateway/relationship-memory-http.js';
import { isAdminActionAllowed, resolveAdminRbacAction } from '../src/security/admin-rbac.js';

vi.mock('../src/memory/relationship-memory.js', () => ({
  listMemoryRelationships: () => ({ relationships: [], nextOffset: null }),
  inspectMemoryRelationship: () => null,
}));

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}
const url = (query = '') => new URL(`http://localhost/api/admin/memory/relationships${query}`);

describe('operator relationship memory boundary', () => {
  test('requires session-read access and exposes no write action', () => {
    const action = resolveAdminRbacAction(url().pathname, 'GET');
    expect(action).toBe('admin.sessions.read');
    expect(isAdminActionAllowed({ actions: ['admin.config.read'] }, action!)).toBe(false);
    expect(isAdminActionAllowed({ actions: ['admin.sessions.read'] }, action!)).toBe(true);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(resolveAdminRbacAction(url().pathname, method)).toBeNull();
    }
  });
  test.each(['?offset=-1', '?offset=1.2', '?offset=9007199254740992', '?agentId=main', '?audienceKey=key', '?agentId=main&audienceKey=key&memoryOffset=abc'])('rejects malformed selectors %s', (query) => {
    expect(() => handleRelationshipMemoryRoute(response(), url(query), 'GET')).toThrow();
  });
  test('returns an empty list and 404 for an unknown agent/audience pair', () => {
    const listRes = response();
    handleRelationshipMemoryRoute(listRes, url(), 'GET');
    expect(listRes.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const detailRes = response();
    handleRelationshipMemoryRoute(detailRes, url('?agentId=main&audienceKey=missing'), 'GET');
    expect(detailRes.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });
  test('refuses mutations', () => {
    const res = response();
    handleRelationshipMemoryRoute(res, url(), 'POST');
    expect(res.writeHead).toHaveBeenCalledWith(405, expect.anything());
  });
});
