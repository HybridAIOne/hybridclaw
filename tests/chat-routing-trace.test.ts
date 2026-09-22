import { beforeEach, expect, it, vi } from 'vitest';
import { withChatRoutingTrace } from '../src/gateway/chat-routing-trace.js';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
import { finishRoutingTraceAttempt, startRoutingTraceAttempt } from '../src/usage/routing-trace.js';

const mocks = vi.hoisted(() => ({ show: false, persist: vi.fn(), usage: vi.fn(), audit: vi.fn() }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: () => ({ routing: { showRoutingInfo: mocks.show } }) }));
vi.mock('../src/memory/messages.js', () => ({ setMessageRoutingTrace: mocks.persist }));
vi.mock('../src/usage/token-usage-buffer.js', () => ({ enqueueTokenUsage: mocks.usage }));
vi.mock('../src/audit/audit-events.js', () => ({ makeAuditRunId: () => 'test-run', recordAuditEvent: mocks.audit }));
vi.mock('../src/providers/model-catalog.js', () => ({ getModelCatalogMetadata: () => ({ zone: 'local', pricingUsdPerToken: {} }) }));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));
const req = { sessionId: 'test-session', agentId: 'main', onRoutingTrace: vi.fn() } as unknown as GatewayChatRequest;
beforeEach(() => { vi.clearAllMocks(); mocks.show = false; });
async function work() {
  const attempt = startRoutingTraceAttempt('local/router', 'auxiliary', 'concierge');
  finishRoutingTraceAttempt({ model: 'local/router', attempt, status: 'success', durationMs: 5, inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
  startRoutingTraceAttempt('local/answer');
  finishRoutingTraceAttempt({ model: 'local/answer', status: 'success', durationMs: 10 });
  return { status: 'success' as const, result: 'Answer', toolsUsed: [], assistantMessageId: 1, agentId: 'main' };
}
it('persists and meters when presentation is off, without disclosing progress or results', async () => {
  const result = await withChatRoutingTrace(req, work);
  expect(result.routingTrace).toBeUndefined();
  expect(req.onRoutingTrace).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'complete' }));
  expect(mocks.usage).toHaveBeenCalledTimes(1);
  expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.01 }));
});
it('shows the same record that was persisted and preserves unknown cost', async () => {
  mocks.show = true;
  const result = await withChatRoutingTrace(req, work);
  expect(req.onRoutingTrace).toHaveBeenCalledTimes(2);
  expect(result.routingTrace).toEqual(mocks.persist.mock.calls[0][1]);
  expect(result.routingTrace?.attempts[1].costUsd).toBeNull();
});
it('preserves the answer on a persistence failure', async () => {
  mocks.persist.mockImplementationOnce(() => { throw new Error('disk full'); });
  expect((await withChatRoutingTrace(req, work)).result).toBe('Answer');
});
