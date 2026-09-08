import { logger } from '../logger.js';
import type { ContainerOutput } from '../types/container.js';
import type { DelegationSideEffect } from '../types/side-effects.js';

interface SideEffectHandlers {
  onDelegation?: (effect: DelegationSideEffect) => void;
  onError?: (message: string) => void;
}

function describeSideEffectError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatSideEffectNotice(notices: string[]): string | null {
  const normalized = notices.map((n) => n.trim()).filter(Boolean);
  if (normalized.length === 0) return null;
  return `⚠️ ${normalized.join(' ')}`;
}

export function processSideEffects(
  output: ContainerOutput,
  sessionId: string,
  channelId: string,
  handlers: SideEffectHandlers = {},
): void {
  const delegations = output.sideEffects?.delegations || [];
  if (delegations.length === 0) return;

  for (const effect of delegations) {
    try {
      if (handlers.onDelegation) {
        handlers.onDelegation(effect);
      } else {
        logger.warn(
          {
            sessionId,
            channelId,
            mode:
              effect.mode ||
              (effect.chain?.length
                ? 'chain'
                : effect.tasks?.length
                  ? 'parallel'
                  : 'single'),
            prompt: effect.prompt,
            label: effect.label,
            tasks: effect.tasks?.length,
            chain: effect.chain?.length,
          },
          'Side-effect: delegation dropped (no handler)',
        );
      }
    } catch (err) {
      logger.error({ effect, err }, 'Failed to process delegation side-effect');
      handlers.onError?.(
        `Delegation could not be started: ${describeSideEffectError(err)}`,
      );
    }
  }
}
