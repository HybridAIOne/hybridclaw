import { vi } from 'vitest';

const gatewayAuxiliaryMockState = vi.hoisted(() => {
  const prelude = "I'm coming online now.";
  return {
    DEFAULT_GATEWAY_AUXILIARY_PRELUDE: prelude,
    callAuxiliaryModelMock: vi.fn(async () => ({
      provider: 'hybridai',
      model: 'auxiliary/test',
      content: prelude,
    })),
  };
});

vi.mock('../../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: gatewayAuxiliaryMockState.callAuxiliaryModelMock,
}));

export const DEFAULT_GATEWAY_AUXILIARY_PRELUDE =
  gatewayAuxiliaryMockState.DEFAULT_GATEWAY_AUXILIARY_PRELUDE;
export const callAuxiliaryModelMock =
  gatewayAuxiliaryMockState.callAuxiliaryModelMock;
