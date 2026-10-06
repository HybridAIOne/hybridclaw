import type { ServerResponse } from 'node:http';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  auxiliary: vi.fn(), resolveAgent: vi.fn(), credentials: vi.fn(), regular: vi.fn(),
}));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.auxiliary }));
vi.mock('../src/agents/agent-registry.js', () => ({ resolveAgentForRequest: mocks.resolveAgent }));
vi.mock('../src/providers/factory.js', () => ({ resolveModelRuntimeCredentials: mocks.credentials }));
vi.mock('../src/gateway/openai-compatible-model.js', () => ({ callOpenAICompatibleModel: mocks.regular }));
const { handleDecisionCompletion, isDecisionModel } = await import('../src/gateway/openai-decision.js');
useCleanMocks({ cleanup: () => { Object.values(mocks).forEach(mock => mock.mockReset()); } });
beforeEach(() => {
  mocks.resolveAgent.mockReturnValue({ agentId: 'phone', model: 'vllm/primary', chatbotId: '' });
  mocks.credentials.mockResolvedValue({ provider: 'vllm' });
});

function request(model: string, wantsStream = false) {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  return {
    res,
    params: { res: res as unknown as ServerResponse, model, agentId: 'phone',
      messages: [{ role: 'user' as const, content: 'context' }], wantsStream,
      completionId: 'decision', created: 1, traceHeaders: {} },
  };
}

test('auxiliary completion returns its answer without implicit regular fallback', async () => {
  mocks.auxiliary.mockResolvedValue({ model: 'vllm/small', provider: 'vllm', content: '{"emoji":"none"}' });
  const { params, res } = request('auxiliary/eval_judge');
  await handleDecisionCompletion(params);
  expect(mocks.auxiliary).toHaveBeenCalledWith(expect.objectContaining({ messages: params.messages, allowFallback: false, temperature: 0 }));
  expect(JSON.parse(res.end.mock.calls[0][0]).choices[0].message.content).toBe('{"emoji":"none"}');
  expect(mocks.regular).not.toHaveBeenCalled();
});

test('auxiliary failure propagates for the client to decide its next step', async () => {
  mocks.auxiliary.mockRejectedValue(new Error('unavailable'));
  await expect(handleDecisionCompletion(request('auxiliary/eval_judge').params)).rejects.toThrow('unavailable');
  expect(mocks.regular).not.toHaveBeenCalled();
});

test('regular decision uses the selected agent model and supplied context with no tools', async () => {
  mocks.regular.mockResolvedValue({ choices: [{ message: { content: '{"look":"autumn"}' } }] });
  const { params, res } = request('regular');
  await handleDecisionCompletion(params);
  expect(mocks.resolveAgent).toHaveBeenCalledWith({ agentId: 'phone' });
  expect(mocks.regular).toHaveBeenCalledWith({ runtime: { provider: 'vllm' }, model: 'vllm/primary', messages: params.messages, tools: [], toolChoice: 'none' });
  const answer = JSON.parse(res.end.mock.calls[0][0]);
  expect(answer.model).toBe('vllm/primary');
  expect(answer.choices[0].message.content).toBe('{"look":"autumn"}');
  expect(mocks.auxiliary).not.toHaveBeenCalled();
});

test.each(['regular', 'auxiliary/eval_judge'])('streaming %s decisions fail before model execution', async model => {
  await expect(handleDecisionCompletion(request(model, true).params)).rejects.toMatchObject({ statusCode: 400 });
  expect(mocks.regular).not.toHaveBeenCalled();
  expect(mocks.auxiliary).not.toHaveBeenCalled();
});

test('only explicit decision aliases bypass chat execution', () => {
  expect(isDecisionModel('regular')).toBe(true);
  expect(isDecisionModel('auxiliary/eval_judge')).toBe(true);
  expect(isDecisionModel('auxiliary/vision')).toBe(false);
  expect(isDecisionModel('vllm/primary')).toBe(false);
});
