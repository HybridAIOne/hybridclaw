import { isSilentReply } from '../agent/silent-reply.js';
import {
  getActiveThreadGoal,
  resolveGoalThreadId,
} from '../goals/goal-manager.js';
import {
  buildGoalContinuationPrompt,
  buildGoalInitialPrompt,
  clearScheduledGoalContinuation,
  finishGoalContinuationRun,
  GOAL_CONTINUATION_SOURCE,
  getGoalContinuationContext,
  isGoalContinuationRunning,
  isGoalInitialPromptScheduled,
  registerGoalPostTurnSubscriber,
  setGoalContinuationRunHandler,
  setGoalContinuationRunning,
} from '../goals/goal-runtime.js';
import { enqueueProactiveMessage } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { handleGatewayMessage } from './gateway-chat-service.js';

const MAX_QUEUED_GOAL_MESSAGES = 100;

async function emitGoalMessage(params: {
  channelId: string;
  context: ReturnType<typeof getGoalContinuationContext>;
  text: string;
  artifacts?: Array<{ path: string; filename: string; mimeType: string }>;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) return;
  if (params.context?.onProactiveMessage) {
    await params.context.onProactiveMessage({
      channelId: params.channelId,
      text,
      artifacts: params.artifacts,
    });
    return;
  }
  enqueueProactiveMessage(
    params.channelId,
    text,
    GOAL_CONTINUATION_SOURCE,
    MAX_QUEUED_GOAL_MESSAGES,
  );
}

async function runGoalContinuation(sessionId: string): Promise<void> {
  if (isGoalContinuationRunning(sessionId)) return;
  const session = memoryService.getSessionById(sessionId);
  if (!session) return;
  const goal = getActiveThreadGoal(resolveGoalThreadId(session));
  if (!goal) {
    clearScheduledGoalContinuation(sessionId);
    return;
  }
  const context = getGoalContinuationContext(sessionId);
  if (!context) {
    clearScheduledGoalContinuation(sessionId);
    return;
  }

  setGoalContinuationRunning(sessionId, true);
  try {
    const initialPrompt = isGoalInitialPromptScheduled(sessionId);
    const result = await handleGatewayMessage({
      sessionId,
      guildId: context.guildId,
      channelId: session.channel_id,
      userId: context.userId,
      username: context.username,
      content: initialPrompt
        ? buildGoalInitialPrompt(goal.goalText)
        : buildGoalContinuationPrompt({
            goalText: goal.goalText,
            reason: goal.lastReason,
          }),
      agentId: goal.targetAgentId ?? session.agent_id,
      chatbotId: context.chatbotId ?? session.chatbot_id,
      model: context.model ?? session.model,
      enableRag: context.enableRag ?? session.enable_rag === 1,
      onProactiveMessage: context.onProactiveMessage,
      source: GOAL_CONTINUATION_SOURCE,
    });
    const resultText = String(result.result || '').trim();
    if (
      result.status === 'success' &&
      resultText &&
      !isSilentReply(resultText)
    ) {
      await emitGoalMessage({
        channelId: session.channel_id,
        context,
        text: resultText,
        artifacts: result.artifacts,
      });
    }
  } finally {
    finishGoalContinuationRun(sessionId);
  }
}

export function initializeGoalContinuationRunner(): void {
  registerGoalPostTurnSubscriber();
  setGoalContinuationRunHandler(runGoalContinuation);
}
