import {
  FULLAUTO_COOLDOWN_MS,
  PROACTIVE_RALPH_MAX_ITERATIONS,
} from '../config/config.js';
import { logger } from '../logger.js';
import type { ArtifactMetadata } from '../types/execution.js';
import type { Session } from '../types/session.js';
import {
  appendFullAutoRunLogEntry,
  looksLikeSyntheticFullAutoPrompt,
} from './fullauto-workspace.js';
import { interruptGatewaySessionExecution } from './gateway-request-runtime.js';
import type { GatewayChatResult } from './gateway-types.js';

const FULLAUTO_DEFAULT_USER_ID = 'fullauto-user';
const FULLAUTO_DEFAULT_USERNAME = 'fullauto';

export interface ProactiveMessagePayload {
  text: string;
  artifacts?: ArtifactMetadata[];
}

export interface FullAutoRequestContext {
  guildId: string | null;
  userId: string;
  username: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  source?: string;
}

export interface FullAutoRuntimeState {
  timer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  running: boolean;
  turns: number;
  consecutiveErrors: number;
  consecutiveStalls: number;
  guildId: string | null;
  userId: string;
  username: string | null;
  chatbotId: string | null;
  model: string | null;
  enableRag: boolean | null;
  activeRunToken: number | null;
  lastTurnStartedAt: number | null;
  lastProgressAt: number | null;
  lastProgressLabel: string | null;
  lastInterventionAt: number | null;
  watchdogInterruptedRunToken: number | null;
  onProactiveMessage?:
    | ((message: ProactiveMessagePayload) => void | Promise<void>)
    | null;
}

const fullAutoRuntimeBySession = new Map<string, FullAutoRuntimeState>();
let runFullAutoTurnHandler: ((sessionId: string) => Promise<void>) | null =
  null;

export function setFullAutoRunHandler(
  handler: (sessionId: string) => Promise<void>,
): void {
  runFullAutoTurnHandler = handler;
}

export function getOrCreateFullAutoRuntimeState(
  sessionId: string,
): FullAutoRuntimeState {
  let state = fullAutoRuntimeBySession.get(sessionId);
  if (state) return state;
  state = {
    timer: null,
    watchdogTimer: null,
    running: false,
    turns: 0,
    consecutiveErrors: 0,
    consecutiveStalls: 0,
    guildId: null,
    userId: FULLAUTO_DEFAULT_USER_ID,
    username: FULLAUTO_DEFAULT_USERNAME,
    chatbotId: null,
    model: null,
    enableRag: null,
    activeRunToken: null,
    lastTurnStartedAt: null,
    lastProgressAt: null,
    lastProgressLabel: null,
    lastInterventionAt: null,
    watchdogInterruptedRunToken: null,
    onProactiveMessage: null,
  };
  fullAutoRuntimeBySession.set(sessionId, state);
  return state;
}

function clearFullAutoTimer(sessionId: string): void {
  const state = fullAutoRuntimeBySession.get(sessionId);
  if (!state?.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}

export function clearFullAutoWatchdog(sessionId: string): void {
  const state = fullAutoRuntimeBySession.get(sessionId);
  if (!state?.watchdogTimer) return;
  clearInterval(state.watchdogTimer);
  state.watchdogTimer = null;
}

export function clearFullAutoRuntimeState(sessionId: string): void {
  clearFullAutoTimer(sessionId);
  clearFullAutoWatchdog(sessionId);
  if (!fullAutoRuntimeBySession.get(sessionId)?.running) {
    fullAutoRuntimeBySession.delete(sessionId);
  }
}

export function clearScheduledFullAutoContinuation(sessionId: string): void {
  clearFullAutoTimer(sessionId);
}

export function invalidateFullAutoRuntimeState(sessionId: string): void {
  const state = fullAutoRuntimeBySession.get(sessionId);
  if (!state) return;
  clearFullAutoTimer(sessionId);
  clearFullAutoWatchdog(sessionId);
  state.running = false;
  state.activeRunToken = null;
  fullAutoRuntimeBySession.delete(sessionId);
}

export function isCurrentFullAutoRuntimeState(
  sessionId: string,
  state: FullAutoRuntimeState,
): boolean {
  return fullAutoRuntimeBySession.get(sessionId) === state;
}

export function getFullAutoRuntimeState(
  sessionId: string,
): FullAutoRuntimeState | undefined {
  return fullAutoRuntimeBySession.get(sessionId);
}

export function isFullAutoEnabled(session: Session): boolean {
  return session.full_auto_enabled === 1;
}

export function resolveSessionRalphIterations(session: Session): number {
  return isFullAutoEnabled(session) ? -1 : PROACTIVE_RALPH_MAX_ITERATIONS;
}

export function markFullAutoProgress(
  sessionId: string,
  state: FullAutoRuntimeState,
  label: string,
): void {
  if (!isCurrentFullAutoRuntimeState(sessionId, state)) return;
  state.lastProgressAt = Date.now();
  state.lastProgressLabel = label.trim() || null;
}

export function syncFullAutoRuntimeContext(
  sessionId: string,
  params: {
    guildId?: string | null;
    userId?: string | null;
    username?: string | null;
    chatbotId?: string | null;
    model?: string | null;
    enableRag?: boolean | null;
    onProactiveMessage?:
      | ((message: ProactiveMessagePayload) => void | Promise<void>)
      | null;
  },
): FullAutoRuntimeState {
  const state = getOrCreateFullAutoRuntimeState(sessionId);
  if (params.guildId !== undefined) state.guildId = params.guildId;
  if (typeof params.userId === 'string' && params.userId.trim()) {
    state.userId = params.userId.trim();
  }
  if (params.username !== undefined) {
    state.username =
      typeof params.username === 'string' && params.username.trim()
        ? params.username.trim()
        : null;
  }
  if (params.chatbotId !== undefined) state.chatbotId = params.chatbotId;
  if (params.model !== undefined) state.model = params.model;
  if (params.enableRag !== undefined) state.enableRag = params.enableRag;
  if (params.onProactiveMessage !== undefined) {
    state.onProactiveMessage = params.onProactiveMessage;
  }
  return state;
}

export function buildFullAutoContinuationRequest(
  session: Session,
  state: FullAutoRuntimeState,
): FullAutoRequestContext {
  return {
    guildId: state.guildId ?? session.guild_id,
    userId: state.userId || FULLAUTO_DEFAULT_USER_ID,
    username: state.username ?? FULLAUTO_DEFAULT_USERNAME,
    chatbotId: state.chatbotId ?? session.chatbot_id,
    model: state.model ?? session.model,
    enableRag: state.enableRag ?? session.enable_rag === 1,
    onProactiveMessage: state.onProactiveMessage ?? undefined,
  };
}

export function scheduleFullAutoContinuation(params: {
  session: Session;
  req: FullAutoRequestContext;
  delayMs?: number;
}): void {
  if (!isFullAutoEnabled(params.session)) return;
  const state = syncFullAutoRuntimeContext(params.session.id, {
    guildId: params.req.guildId,
    userId: params.req.userId,
    username: params.req.username ?? null,
    chatbotId: params.req.chatbotId ?? params.session.chatbot_id,
    model: params.req.model ?? params.session.model,
    enableRag: params.req.enableRag ?? params.session.enable_rag === 1,
    onProactiveMessage: params.req.onProactiveMessage,
  });
  clearFullAutoTimer(params.session.id);
  const delayMs = Math.max(
    0,
    Math.floor(params.delayMs ?? FULLAUTO_COOLDOWN_MS),
  );
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!runFullAutoTurnHandler) {
      logger.error(
        { sessionId: params.session.id },
        'Full-auto runner has not been configured',
      );
      return;
    }
    void runFullAutoTurnHandler(params.session.id);
  }, delayMs);
}

function hasPendingApproval(result: GatewayChatResult): boolean {
  return (result.toolExecutions || []).some(
    (execution) => execution.approvalDecision === 'required',
  );
}

export function maybeScheduleFullAutoAfterSuccess(params: {
  session: Session;
  req: FullAutoRequestContext;
  result: GatewayChatResult;
}): void {
  if (!isFullAutoEnabled(params.session)) return;
  if (hasPendingApproval(params.result)) return;
  if (params.req.source === 'fullauto') return;
  scheduleFullAutoContinuation({
    session: params.session,
    req: {
      guildId: params.req.guildId,
      userId: params.req.userId,
      username: params.req.username ?? null,
      chatbotId: params.req.chatbotId ?? params.session.chatbot_id,
      model: params.req.model ?? params.session.model,
      enableRag: params.req.enableRag ?? params.session.enable_rag === 1,
      onProactiveMessage: params.req.onProactiveMessage,
    },
  });
}

export function noteFullAutoSupervisedIntervention(params: {
  session: Session;
  content: string;
  source: string;
}): void {
  if (!isFullAutoEnabled(params.session)) return;
  const normalized = params.content.replace(/\s+/g, ' ').trim();
  if (!normalized || looksLikeSyntheticFullAutoPrompt(normalized)) return;
  appendFullAutoRunLogEntry({
    session: params.session,
    heading: 'supervised-intervention',
    lines: [`- source: ${params.source}`, `- prompt: ${normalized}`],
  });
  const state = fullAutoRuntimeBySession.get(params.session.id);
  if (state) {
    state.lastInterventionAt = Date.now();
    state.lastProgressAt = state.lastInterventionAt;
    state.lastProgressLabel = 'supervised-intervention';
  }
}

export function preemptRunningFullAutoTurn(
  sessionId: string,
  source: string,
): boolean {
  const state = fullAutoRuntimeBySession.get(sessionId);
  if (!state?.running) return false;
  const stopped = interruptGatewaySessionExecution(sessionId);
  invalidateFullAutoRuntimeState(sessionId);
  logger.info(
    {
      sessionId,
      source,
      stopped,
    },
    'Preempted active full-auto turn for supervised intervention',
  );
  return stopped;
}
