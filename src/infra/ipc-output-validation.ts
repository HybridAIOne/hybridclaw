/**
 * Worker reply shapes are checked before gateway consumers see them.
 * File safety belongs to ipc.ts; this boundary rejects malformed payloads
 * without logging their content or granting authority to valid tool history.
 * The shape is the contract's `ContainerOutputSchema`; tool history and token
 * usage add the shared validators, which need Node and so stay out of it.
 */

import {
  type ContainerOutput,
  ContainerOutputSchema,
} from '@hybridclaw/contracts/agent-io';
import { validateTokenUsage } from '@hybridclaw/shared/token-usage';
import { validateToolHistory } from '@hybridclaw/shared/tool-history';

function passes(validate: (value: unknown) => unknown, value: unknown) {
  if (value === undefined) return true;
  try {
    validate(value);
    return true;
  } catch {
    return false;
  }
}

export function isContainerOutput(value: unknown): value is ContainerOutput {
  return (
    ContainerOutputSchema.check(value) &&
    passes(validateToolHistory, value.toolHistory) &&
    passes(validateToolHistory, value.toolHistoryForReplay) &&
    passes(validateTokenUsage, value.tokenUsage)
  );
}
