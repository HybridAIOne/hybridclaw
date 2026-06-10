import type { ContainerOutput } from './types.js';

export function buildInterruptedShutdownOutput(
  reason: NodeJS.Signals,
): ContainerOutput {
  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error: `Request interrupted: the agent process received ${reason} before producing a final response.`,
  };
}
