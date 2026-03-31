import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  deleteMemoryValue,
  getMemoryValue,
  setMemoryValue,
} from '../memory/db.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import type { MediaContextItem } from '../types/container.js';
import {
  buildConciergeQuestion,
  buildConciergeResumePrompt,
  type ConciergeProfile,
  decideConciergeRouting,
  inferPromptUrgencyProfile,
  type PendingConciergeState,
  parseConciergeChoice,
  resolveConciergeProfileModel,
  shouldTriggerConcierge,
} from './concierge-routing.js';

const CONCIERGE_PENDING_STATE_KEY = 'gateway.concierge.pending';

function getPendingConciergeState(
  sessionId: string,
  normalizeMediaContextItems: (raw: unknown) => MediaContextItem[],
): PendingConciergeState | null {
  const raw = getMemoryValue(sessionId, CONCIERGE_PENDING_STATE_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const originalUserContent =
    typeof (raw as { originalUserContent?: unknown }).originalUserContent ===
    'string'
      ? (raw as { originalUserContent: string }).originalUserContent.trim()
      : '';
  if (!originalUserContent) return null;
  const createdAt =
    typeof (raw as { createdAt?: unknown }).createdAt === 'string'
      ? (raw as { createdAt: string }).createdAt
      : new Date().toISOString();
  return {
    originalUserContent,
    createdAt,
    media: normalizeMediaContextItems((raw as { media?: unknown }).media),
  };
}

function setPendingConciergeState(
  sessionId: string,
  state: PendingConciergeState,
): void {
  setMemoryValue(sessionId, CONCIERGE_PENDING_STATE_KEY, state);
}

function clearPendingConciergeState(sessionId: string): void {
  deleteMemoryValue(sessionId, CONCIERGE_PENDING_STATE_KEY);
}

function resolveConciergeExecutionModel(params: {
  profile: ConciergeProfile;
  currentModel: string;
  chatbotId: string;
}): string {
  const configuredModel =
    resolveConciergeProfileModel(getRuntimeConfig(), params.profile) ||
    params.currentModel;
  if (!modelRequiresChatbotId(configuredModel) || params.chatbotId) {
    return configuredModel;
  }
  if (!modelRequiresChatbotId(params.currentModel)) {
    logger.info(
      {
        currentModel: params.currentModel,
        configuredModel,
        profile: params.profile,
      },
      'Concierge routing kept the current model because the configured profile model requires a chatbot',
    );
    return params.currentModel;
  }
  return configuredModel;
}

export type ConciergeTurnResolution =
  | {
      kind: 'respond';
      resultText: string;
    }
  | {
      kind: 'continue';
      conciergeExecutionProfile: ConciergeProfile | null;
      model: string;
      provider: ReturnType<typeof resolveModelProvider>;
      media: MediaContextItem[];
      effectiveUserTurnContent: string;
      effectiveUserTurnContentExpanded: string;
      effectiveUserTurnContentStripped: string;
    };

export async function resolveConciergeTurn(params: {
  sessionId: string;
  requestContent: string;
  agentId: string;
  chatbotId: string;
  currentModel: string;
  isInteractiveSource: boolean;
  explicitModelPinned: boolean;
  media: MediaContextItem[];
  effectiveUserTurnContent: string;
  effectiveUserTurnContentExpanded: string;
  effectiveUserTurnContentStripped: string;
  normalizeMediaContextItems: (raw: unknown) => MediaContextItem[];
  cloneMediaContextItems: (media: MediaContextItem[]) => MediaContextItem[];
}): Promise<ConciergeTurnResolution> {
  const pendingConciergeState = getPendingConciergeState(
    params.sessionId,
    params.normalizeMediaContextItems,
  );
  let conciergeExecutionProfile: ConciergeProfile | null = null;
  let model = params.currentModel;
  let media = params.media;
  let effectiveUserTurnContent = params.effectiveUserTurnContent;
  let effectiveUserTurnContentExpanded =
    params.effectiveUserTurnContentExpanded;
  let effectiveUserTurnContentStripped =
    params.effectiveUserTurnContentStripped;

  if (params.isInteractiveSource && pendingConciergeState) {
    const chosenProfile = parseConciergeChoice(params.requestContent);
    if (!chosenProfile) {
      return {
        kind: 'respond',
        resultText: buildConciergeQuestion({ invalidChoice: true }),
      };
    }
    clearPendingConciergeState(params.sessionId);
    conciergeExecutionProfile = chosenProfile;
    media = params.cloneMediaContextItems(pendingConciergeState.media);
    model = resolveConciergeExecutionModel({
      profile: chosenProfile,
      currentModel: model,
      chatbotId: params.chatbotId,
    });
    effectiveUserTurnContent = pendingConciergeState.originalUserContent;
    effectiveUserTurnContentExpanded = buildConciergeResumePrompt(
      pendingConciergeState.originalUserContent,
      chosenProfile,
    );
    effectiveUserTurnContentStripped =
      pendingConciergeState.originalUserContent;
  } else if (
    params.isInteractiveSource &&
    getRuntimeConfig().routing.concierge.enabled &&
    !params.explicitModelPinned
  ) {
    const inferredProfile = inferPromptUrgencyProfile(
      effectiveUserTurnContentStripped,
    );
    if (inferredProfile) {
      conciergeExecutionProfile = inferredProfile;
      model = resolveConciergeExecutionModel({
        profile: inferredProfile,
        currentModel: model,
        chatbotId: params.chatbotId,
      });
      effectiveUserTurnContentExpanded = buildConciergeResumePrompt(
        effectiveUserTurnContentExpanded,
        inferredProfile,
      );
    } else if (
      shouldTriggerConcierge(effectiveUserTurnContentStripped, {
        explicitModelPinned: params.explicitModelPinned,
        interactiveOnly: params.isInteractiveSource,
      })
    ) {
      const decision = await decideConciergeRouting({
        content: effectiveUserTurnContentStripped,
        agentId: params.agentId,
        chatbotId: params.chatbotId,
      });
      if (decision.kind === 'pick_profile') {
        conciergeExecutionProfile = decision.profile;
        model = resolveConciergeExecutionModel({
          profile: decision.profile,
          currentModel: model,
          chatbotId: params.chatbotId,
        });
        effectiveUserTurnContentExpanded = buildConciergeResumePrompt(
          effectiveUserTurnContentExpanded,
          decision.profile,
        );
      } else {
        setPendingConciergeState(params.sessionId, {
          originalUserContent: effectiveUserTurnContentExpanded,
          createdAt: new Date().toISOString(),
          media: params.cloneMediaContextItems(media),
        });
        return {
          kind: 'respond',
          resultText: buildConciergeQuestion(),
        };
      }
    }
  }

  return {
    kind: 'continue',
    conciergeExecutionProfile,
    model,
    provider: resolveModelProvider(model),
    media,
    effectiveUserTurnContent,
    effectiveUserTurnContentExpanded,
    effectiveUserTurnContentStripped,
  };
}
