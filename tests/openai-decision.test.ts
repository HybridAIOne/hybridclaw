import type { ServerResponse } from 'node:http';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  auxiliary: vi.fn(), resolveAgent: vi.fn(), credentials: vi.fn(), regular: vi.fn(), recordUsage: vi.fn(),
}));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.auxiliary }));
vi.mock('../src/agents/agent-registry.js', () => ({ resolveAgentForRequest: mocks.resolveAgent }));
vi.mock('../src/providers/factory.js', () => ({ resolveModelRuntimeCredentials: mocks.credentials }));
vi.mock('../src/gateway/openai-compatible-model.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/gateway/openai-compatible-model.js')>()), callOpenAICompatibleModel: mocks.regular,
}));
vi.mock('../src/gateway/openai-compatible-usage.js', () => ({ recordOpenAICompatibleUsage: mocks.recordUsage }));
const { handleDecisionCompletion, isDecisionModel } = await import('../src/gateway/openai-decision.js');
useCleanMocks({ cleanup: () => { Object.values(mocks).forEach(mock => mock.mockReset()); } });
beforeEach(() => {
  mocks.resolveAgent.mockReturnValue({ agentId: 'phone', model: 'vllm/primary', chatbotId: '' });
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.credentials.mockResolvedValue({ provider: 'vllm' });
});

function request(model: string, wantsStream = false) {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  return {
    res,
    params: { res: res as unknown as ServerResponse, model, sessionId: 'session_a', agentId: 'phone',
      messages: [{ role: 'user' as const, content: 'context' }], wantsStream,
      completionId: 'decision', created: 1, traceHeaders: {} },
  };
}

test.each(['auxiliary/quick_decision', 'auxiliary/eval_judge'])('%s answers from the quick_decision task without implicit regular fallback', async model => {
  mocks.auxiliary.mockResolvedValue({ model: 'vllm/small', provider: 'vllm', content: '{"emoji":"none"}' });
  const { params, res } = request(model);
  await handleDecisionCompletion(params);
  expect(mocks.auxiliary).toHaveBeenCalledWith(expect.objectContaining({ task: 'quick_decision', messages: params.messages, allowFallback: false, temperature: 0 }));
  expect(JSON.parse(res.end.mock.calls[0][0]).choices[0].message.content).toBe('{"emoji":"none"}');
  expect(mocks.regular).not.toHaveBeenCalled();
  expect(mocks.recordUsage).not.toHaveBeenCalled();
});

test('auxiliary failure is unavailable for the client to decide its next step', async () => {
  mocks.auxiliary.mockRejectedValue(new Error('unavailable'));
  await expect(handleDecisionCompletion(request('auxiliary/quick_decision').params))
    .rejects.toMatchObject({ statusCode: 503, code: 'auxiliary_unavailable', message: 'unavailable' });
  expect(mocks.regular).not.toHaveBeenCalled();
});

test('regular decision uses the selected agent model and supplied context with no tools', async () => {
  mocks.regular.mockResolvedValue({
    choices: [{ message: { content: '{"look":"autumn"}' } }],
    usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
  });
  const { params, res } = request('regular');
  await handleDecisionCompletion(params);
  expect(mocks.resolveAgent).toHaveBeenCalledWith({ agentId: 'phone' });
  expect(mocks.regular).toHaveBeenCalledWith({ runtime: { provider: 'vllm' }, model: 'vllm/primary', messages: params.messages, tools: [], toolChoice: 'none' });
  const answer = JSON.parse(res.end.mock.calls[0][0]);
  expect(answer.model).toBe('vllm/primary');
  expect(answer.choices[0].message.content).toBe('{"look":"autumn"}');
  expect(mocks.auxiliary).not.toHaveBeenCalled();
  expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
  expect(mocks.recordUsage).toHaveBeenCalledWith({
    sessionId: 'session_a', agentId: 'phone', model: 'vllm/primary',
    tokenUsage: expect.objectContaining({ apiPromptTokens: 50, apiCompletionTokens: 5, apiTotalTokens: 55 }),
  });
});

test.each(['regular', 'auxiliary/quick_decision'])('streaming %s decisions fail before model execution', async model => {
  await expect(handleDecisionCompletion(request(model, true).params)).rejects.toMatchObject({ statusCode: 400 });
  expect(mocks.regular).not.toHaveBeenCalled();
  expect(mocks.auxiliary).not.toHaveBeenCalled();
});

test('only explicit decision aliases bypass chat execution', () => {
  expect(isDecisionModel('regular')).toBe(true);
  expect(isDecisionModel('auxiliary/quick_decision')).toBe(true);
  expect(isDecisionModel('auxiliary/eval_judge')).toBe(true);
  expect(isDecisionModel('auxiliary/vision')).toBe(false);
  expect(isDecisionModel('vllm/primary')).toBe(false);
});
