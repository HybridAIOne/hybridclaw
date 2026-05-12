import type { TurnContext } from 'botbuilder-core';
import { ActivityTypes } from 'botframework-schema';
import { logger } from '../../logger.js';

const DEFAULT_TYPING_INTERVAL_MS = 4_000;

export function createMSTeamsTypingController(
  turnContext: TurnContext,
  intervalMs = DEFAULT_TYPING_INTERVAL_MS,
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;

  const sendTyping = async (): Promise<void> => {
    try {
      await turnContext.sendActivity({ type: ActivityTypes.Typing });
    } catch (error) {
      logger.debug({ error }, 'Teams typing indicator failed');
    }
  };

  return {
    start(): void {
      if (active) return;
      active = true;
      void sendTyping();
      timer = setInterval(
        () => {
          void sendTyping();
        },
        Math.max(1_000, intervalMs),
      );
    },
    stop(): void {
      active = false;
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
