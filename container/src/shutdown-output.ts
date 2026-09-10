import type { ContainerOutput } from './types.js';

export function buildInterruptedShutdownOutput(
  reason: NodeJS.Signals,
  sideEffects?: ContainerOutput['sideEffects'],
): ContainerOutput {
  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error: `Request interrupted: the agent process received ${reason} before producing a final response.`,
    ...(sideEffects ? { sideEffects } : {}),
  };
}
