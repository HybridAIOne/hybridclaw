import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../agent/agent.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import { isSilentReply } from '../agent/silent-reply.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import {
  FULLAUTO_COOLDOWN_MS,
  FULLAUTO_DEFAULT_PROMPT,
  FULLAUTO_MAX_CONSECUTIVE_ERRORS,
  FULLAUTO_MAX_CONSECUTIVE_STALLS,
  FULLAUTO_MAX_CONSECUTIVE_TURNS,
  FULLAUTO_MAX_SESSION_COST_USD,
  FULLAUTO_MAX_SESSION_TOTAL_TOKENS,
  FULLAUTO_NEVER_APPROVE_TOOLS,
  FULLAUTO_RESUME_ON_BOOT_DELAY_MS,
  FULLAUTO_STALL_POLL_MS,
  FULLAUTO_STALL_RECOVERY_DELAY_MS,
  FULLAUTO_STALL_TIMEOUT_MS,
  HYBRIDAI_MODEL,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_RALPH_MAX_ITERATIONS,
} from '../config/config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import {
  enqueueProactiveMessage,
  getEnabledFullAutoSessions,
  getSessionUsageTotals,
  updateSessionFullAuto,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import type {
  ArtifactMetadata,
  ChatMessage,
  Session,
  ToolProgressEvent,
} from '../types.js';
import { sleep } from '../utils/sleep.js';
import {
  classifyGatewayError,
  type GatewayErrorClass,
} from './gateway-error-utils.js';
import {
  abbreviateForUser,
  formatCompactNumber,
  formatRalphIterations,
} from './gateway-formatting.js';
import {
  interruptGatewaySessionExecution,
  registerActiveGatewayRequest,
} from './gateway-request-runtime.js';
import { parseTimestampMs } from './gateway-time.js';
import type {
  GatewayChatResult,
  GatewayCommandRequest,
} from './gateway-types.js';

const MAX_QUEUED_FULLAUTO_MESSAGES = 100;
const FULLAUTO_OUTSIDE_HOURS_DELAY_MS = 60_000;
const FULLAUTO_DEFAULT_USER_ID = 'fullauto-user';
const FULLAUTO_DEFAULT_USERNAME = 'fullauto';
const FULLAUTO_STATE_DIRNAME = 'fullauto';
const FULLAUTO_GOAL_FILENAME_PREFIX = 'GOAL_';
const FULLAUTO_LEARNING_FILENAME_PREFIX = 'LEARNING_';
const FULLAUTO_RUN_LOG_FILENAME_PREFIX = 'RUN_LOG_';
const FULLAUTO_LEARNING_SESSION_SUFFIX = ':fullauto-learning';
const FULLAUTO_GOAL_PROMPT_MAX_CHARS = 1_500;
const FULLAUTO_LEARNINGS_PROMPT_MAX_CHARS = 3_000;
const FULLAUTO_INTERVENTION_PROMPT_MAX_CHARS = 1_500;
const FULLAUTO_RECENT_INTERVENTIONS = 6;
const FULLAUTO_LEARNING_RESULT_INPUT_MAX_CHARS = 4_000;
const FULLAUTO_LEARNING_STATE_MAX_CHARS = 4_000;
const FULLAUTO_RUN_LOG_RESULT_MAX_CHARS = 1_500;
const FULLAUTO_STATUS_PROMPT_MAX_CHARS = 180;
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

interface FullAutoTurnRequest extends FullAutoRequestContext {
  sessionId: string;
  channelId: string;
  content: string;
  onTextDelta?: (delta: string) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
}

interface FullAutoRuntimeHost {
  handleGatewayMessage: (
    req: FullAutoTurnRequest,
  ) => Promise<GatewayChatResult>;
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
let fullAutoStartupResumed = false;
let nextFullAutoRunToken = 1;
let fullAutoHost: FullAutoRuntimeHost | null = null;

export function configureFullAutoRuntime(host: FullAutoRuntimeHost): void {
  fullAutoHost = host;
}

function requireFullAutoHost(): FullAutoRuntimeHost {
  if (fullAutoHost) return fullAutoHost;
  throw new Error('Full-auto runtime host has not been configured.');
}

function getOrCreateFullAutoRuntimeState(
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

function clearFullAutoWatchdog(sessionId: string): void {
  const state = fullAutoRuntimeBySession.get(sessionId);
  if (!state?.watchdogTimer) return;
  clearInterval(state.watchdogTimer);
  state.watchdogTimer = null;
}

function clearFullAutoRuntimeState(sessionId: string): void {
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

function isCurrentFullAutoRuntimeState(
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

export function resolveFullAutoPrompt(session: Session): string {
  return session.full_auto_prompt?.trim() || FULLAUTO_DEFAULT_PROMPT;
}

function resolveFullAutoRunId(session: Session): string {
  const raw = session.full_auto_started_at?.trim();
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('.', '_');
    }
    const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (normalized) return normalized;
  }
  return 'legacy';
}

function resolveFullAutoWorkspacePaths(session: Session): {
  workspacePath: string;
  stateDirPath: string;
  runId: string;
  goalPath: string;
  learningsPath: string;
  runLogPath: string;
} {
  const { agentId } = resolveAgentForRequest({ session });
  const workspacePath = path.resolve(agentWorkspaceDir(agentId));
  const runId = resolveFullAutoRunId(session);
  const stateDirPath = path.join(workspacePath, FULLAUTO_STATE_DIRNAME);
  return {
    workspacePath,
    stateDirPath,
    runId,
    goalPath: path.join(
      stateDirPath,
      `${FULLAUTO_GOAL_FILENAME_PREFIX}${runId}.md`,
    ),
    learningsPath: path.join(
      stateDirPath,
      `${FULLAUTO_LEARNING_FILENAME_PREFIX}${runId}.md`,
    ),
    runLogPath: path.join(
      stateDirPath,
      `${FULLAUTO_RUN_LOG_FILENAME_PREFIX}${runId}.md`,
    ),
  };
}

function getFullAutoWorkspaceState(session: Session): {
  workspacePath: string;
  stateDirPath: string;
  runId: string;
  goalPath: string;
  goalExists: boolean;
  learningsPath: string;
  learningsExists: boolean;
  runLogPath: string;
  runLogExists: boolean;
} {
  const paths = resolveFullAutoWorkspacePaths(session);
  return {
    ...paths,
    goalExists: fs.existsSync(paths.goalPath),
    learningsExists: fs.existsSync(paths.learningsPath),
    runLogExists: fs.existsSync(paths.runLogPath),
  };
}

function buildFullAutoGoalFileContent(
  session: Session,
  prompt: string | null,
  runId: string,
): string {
  const objective =
    (typeof prompt === 'string' && prompt.trim()) ||
    resolveFullAutoPrompt(session);
  return [
    '# Goal',
    '',
    `Run ID: ${runId}`,
    `Started: ${session.full_auto_started_at || new Date().toISOString()}`,
    '',
    '## Current objective',
    objective,
    '',
    '## Scope',
    '- Treat this as the current high-level objective for the active full-auto run.',
    '- Use the learning state and supervised interventions to refine execution without losing the main objective.',
    '',
  ].join('\n');
}

function buildInitialFullAutoLearningState(
  session: Session,
  runId: string,
): string {
  return [
    '# Learning State',
    '',
    `Run ID: ${runId}`,
    `Last updated: ${new Date().toISOString()}`,
    '',
    '## Objective alignment',
    resolveFullAutoPrompt(session),
    '',
    '## Durable learnings',
    '- None yet.',
    '',
    '## Active constraints and preferences',
    '- None recorded yet.',
    '',
    '## Recent supervised interventions',
    '- None yet.',
    '',
    '## Current strategy',
    '- Start from the current goal, do one meaningful step, then rewrite this file with updated state.',
    '',
    '## Open questions',
    '- None yet.',
    '',
    '## Next step',
    '- Execute the first meaningful step for this run.',
    '',
  ].join('\n');
}

function appendFullAutoRunLogEntry(params: {
  session: Session;
  heading: string;
  lines: string[];
}): void {
  const workspace = getFullAutoWorkspaceState(params.session);
  fs.mkdirSync(workspace.stateDirPath, { recursive: true });
  if (!workspace.runLogExists) {
    fs.writeFileSync(
      workspace.runLogPath,
      [
        '# Full-Auto Run Log',
        '',
        `Run ID: ${workspace.runId}`,
        `Started: ${params.session.full_auto_started_at || new Date().toISOString()}`,
        '',
      ].join('\n'),
      'utf8',
    );
  }
  const entry = [
    `## ${new Date().toISOString()} - ${params.heading}`,
    ...params.lines.filter((line) => line.trim().length > 0),
    '',
  ].join('\n');
  fs.appendFileSync(workspace.runLogPath, entry, 'utf8');
}

function seedFullAutoWorkspaceState(
  session: Session,
  prompt: string | null,
): { goalCreated: boolean; learningsCreated: boolean; runLogCreated: boolean } {
  const workspace = getFullAutoWorkspaceState(session);
  fs.mkdirSync(workspace.workspacePath, { recursive: true });
  fs.mkdirSync(workspace.stateDirPath, { recursive: true });

  let goalCreated = false;
  if (!workspace.goalExists) {
    fs.writeFileSync(
      workspace.goalPath,
      buildFullAutoGoalFileContent(session, prompt, workspace.runId),
      'utf8',
    );
    goalCreated = true;
  }

  let learningsCreated = false;
  if (!workspace.learningsExists) {
    fs.writeFileSync(
      workspace.learningsPath,
      buildInitialFullAutoLearningState(session, workspace.runId),
      'utf8',
    );
    learningsCreated = true;
  }

  let runLogCreated = false;
  if (!workspace.runLogExists) {
    fs.writeFileSync(
      workspace.runLogPath,
      [
        '# Full-Auto Run Log',
        '',
        `Run ID: ${workspace.runId}`,
        `Started: ${session.full_auto_started_at || new Date().toISOString()}`,
        '',
      ].join('\n'),
      'utf8',
    );
    runLogCreated = true;
  }

  return { goalCreated, learningsCreated, runLogCreated };
}

export function describeFullAutoWorkspaceSummary(
  session: Session,
  seeded: {
    goalCreated: boolean;
    learningsCreated: boolean;
    runLogCreated: boolean;
  },
): string {
  const workspace = getFullAutoWorkspaceState(session);
  const goalState = seeded.goalCreated
    ? 'created'
    : workspace.goalExists
      ? 'present'
      : 'missing';
  const learningsState = seeded.learningsCreated
    ? 'created'
    : workspace.learningsExists
      ? 'present'
      : 'missing';
  const runLogState = seeded.runLogCreated
    ? 'created'
    : workspace.runLogExists
      ? 'present'
      : 'missing';
  return `Workspace files: fullauto/GOAL_${workspace.runId}.md ${goalState}, fullauto/LEARNING_${workspace.runId}.md ${learningsState}, fullauto/RUN_LOG_${workspace.runId}.md ${runLogState}`;
}

function readTextFileIfExists(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function trimMultilineText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 4)).trimEnd()}\n...`;
}

function extractLegacyLearningSections(
  raw: string | null,
  maxChars = FULLAUTO_LEARNINGS_PROMPT_MAX_CHARS,
): string | null {
  const normalized = String(raw || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!normalized) return null;

  const sections = normalized
    .split(/\n(?=##\s+\d{4}-\d{2}-\d{2}T)/g)
    .map((section) => section.trim())
    .filter((section) => section.startsWith('## '));
  if (sections.length === 0) {
    return trimMultilineText(normalized, maxChars);
  }

  return trimMultilineText(sections.join('\n\n'), maxChars);
}

function readFullAutoGoalPromptBlock(session: Session): string {
  const { goalPath } = resolveFullAutoWorkspacePaths(session);
  const goalText = readTextFileIfExists(goalPath);
  if (!goalText) return '(goal file missing)';
  return trimMultilineText(goalText, FULLAUTO_GOAL_PROMPT_MAX_CHARS);
}

function readFullAutoLearningsPromptBlock(session: Session): string {
  const { learningsPath } = resolveFullAutoWorkspacePaths(session);
  const learningsText = readTextFileIfExists(learningsPath);
  if (!learningsText) return '(no learning state captured yet)';
  if (learningsText.includes('# Learning State')) {
    return trimMultilineText(
      learningsText,
      FULLAUTO_LEARNINGS_PROMPT_MAX_CHARS,
    );
  }
  return (
    extractLegacyLearningSections(learningsText) ||
    '(no learning state captured yet)'
  );
}

function looksLikeSyntheticFullAutoPrompt(content: string): boolean {
  return (
    content.includes('Durable goal state:') &&
    content.includes('FULLAUTO mode instructions:')
  );
}

function readRecentFullAutoInterventionsFromRunLog(session: Session): string[] {
  const { runLogPath } = resolveFullAutoWorkspacePaths(session);
  const runLogText = readTextFileIfExists(runLogPath);
  if (!runLogText) return [];
  return runLogText
    .split(/\n(?=##\s)/g)
    .map((section) => section.trim())
    .filter((section) => section.startsWith('## '))
    .map((section) => {
      const lines = section.split('\n');
      const heading = lines[0] || '';
      const headingMatch = heading.match(
        /^##\s+(.+?)\s+-\s+supervised-intervention$/,
      );
      if (!headingMatch) return null;
      const sourceLine = lines.find((line) => line.startsWith('- source: '));
      const promptLine = lines.find((line) => line.startsWith('- prompt: '));
      const prompt = promptLine?.slice('- prompt: '.length).trim();
      if (!prompt) return null;
      const source = sourceLine?.slice('- source: '.length).trim();
      const timestamp = parseTimestampMs(headingMatch[1]);
      const label =
        timestamp > 0 ? new Date(timestamp).toISOString() : headingMatch[1];
      return `- ${label}${source ? ` (${source})` : ''}: ${prompt}`;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(-FULLAUTO_RECENT_INTERVENTIONS);
}

function readRecentFullAutoInterventions(session: Session): string {
  const runLogEntries = readRecentFullAutoInterventionsFromRunLog(session);
  if (runLogEntries.length > 0) {
    return trimMultilineText(
      runLogEntries.join('\n'),
      FULLAUTO_INTERVENTION_PROMPT_MAX_CHARS,
    );
  }

  const startedAtMs = parseTimestampMs(session.full_auto_started_at);
  const historyEntries = memoryService
    .getRecentMessages(session.id, 40)
    .filter((message) => {
      if (message.role !== 'user') return false;
      if (
        startedAtMs > 0 &&
        parseTimestampMs(message.created_at) < startedAtMs
      ) {
        return false;
      }
      const content = String(message.content || '').trim();
      if (!content) return false;
      return !looksLikeSyntheticFullAutoPrompt(content);
    })
    .slice(-FULLAUTO_RECENT_INTERVENTIONS)
    .map((message) => {
      const timestamp = parseTimestampMs(message.created_at);
      const normalized = String(message.content || '')
        .replace(/\s+/g, ' ')
        .trim();
      return `- ${timestamp > 0 ? new Date(timestamp).toISOString() : message.created_at}: ${normalized}`;
    })
    .join('\n');
  if (!historyEntries.trim()) return '(no supervised interventions yet)';
  return trimMultilineText(
    historyEntries,
    FULLAUTO_INTERVENTION_PROMPT_MAX_CHARS,
  );
}

function buildFullAutoLearningSessionId(sessionId: string): string {
  return `${sessionId}${FULLAUTO_LEARNING_SESSION_SUFFIX}`;
}

function normalizeFullAutoLearningBody(text: string): string | null {
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  const unwrapped = fenceMatch ? fenceMatch[1].trim() : trimmed;
  if (!unwrapped) return null;
  if (unwrapped.length <= FULLAUTO_LEARNING_STATE_MAX_CHARS) {
    return unwrapped;
  }
  return `${unwrapped.slice(0, FULLAUTO_LEARNING_STATE_MAX_CHARS).trimEnd()}\n...`;
}

function buildFullAutoLearningPrompt(params: {
  session: Session;
  result: GatewayChatResult;
  state: FullAutoRuntimeState;
}): ChatMessage[] {
  const { session, result, state } = params;
  const toolsUsed = [...new Set(result.toolsUsed || [])].filter(Boolean);
  const resultText = trimMultilineText(
    String(result.result || ''),
    FULLAUTO_LEARNING_RESULT_INPUT_MAX_CHARS,
  );
  return [
    {
      role: 'system',
      content: [
        'You are the learning-writer subagent for a full-auto loop.',
        'Your only job is to rewrite the entire active learning-state file for the run.',
        'Infer durable learnings, strategy updates, constraints, failures, recent human steering, and next-step guidance.',
        'Do not produce a transcript and do not append per-turn journal entries.',
        'Compress aggressively: keep only state that materially helps the next autonomous turn.',
        'Return only markdown with exactly this structure:',
        '# Learning State',
        '## Objective alignment',
        '## Durable learnings',
        '## Active constraints and preferences',
        '## Recent supervised interventions',
        '## Current strategy',
        '## Open questions',
        '## Next step',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Full-auto turn just completed: ${state.turns + 1}`,
        `Primary objective: ${resolveFullAutoPrompt(session)}`,
        `Tools used: ${toolsUsed.join(', ') || '(none)'}`,
        '',
        'Goal state:',
        readFullAutoGoalPromptBlock(session),
        '',
        'Current learning state:',
        readFullAutoLearningsPromptBlock(session),
        '',
        'Recent supervised interventions:',
        readRecentFullAutoInterventions(session),
        '',
        'Completed turn result:',
        resultText || '(no visible result)',
        '',
        'Rewrite the full learning-state file now.',
      ].join('\n'),
    },
  ];
}

async function generateFullAutoLearningState(params: {
  sessionId: string;
  session: Session;
  result: GatewayChatResult;
  state: FullAutoRuntimeState;
}): Promise<string | null> {
  const { sessionId, session, result, state } = params;
  const model = state.model ?? session.model ?? HYBRIDAI_MODEL;
  const { agentId, chatbotId } = resolveAgentForRequest({
    session,
    model,
  });
  const executionSessionId = buildFullAutoLearningSessionId(sessionId);
  const activeRequest = registerActiveGatewayRequest({
    sessionId,
    executionSessionId,
  });
  markFullAutoProgress(sessionId, state, 'learning-subagent:start');

  try {
    const output = await runAgent({
      sessionId: executionSessionId,
      messages: buildFullAutoLearningPrompt({ session, result, state }),
      chatbotId,
      enableRag: state.enableRag ?? session.enable_rag === 1,
      model,
      agentId,
      channelId: session.channel_id,
      ralphMaxIterations: 0,
      fullAutoEnabled: false,
      scheduledTasks: [],
      allowedTools: [],
      blockedTools: [],
      onTextDelta: (delta) => {
        if (!delta) return;
        markFullAutoProgress(sessionId, state, 'learning-subagent:text');
      },
      abortSignal: activeRequest.signal,
    });
    if (output.status !== 'success') {
      logger.warn(
        {
          sessionId,
          error: output.error || 'Unknown learning subagent error',
        },
        'Full-auto learning subagent failed',
      );
      return null;
    }
    const learningState = normalizeFullAutoLearningBody(
      String(output.result || ''),
    );
    if (!learningState) {
      logger.warn(
        { sessionId },
        'Full-auto learning subagent returned empty output',
      );
      return null;
    }
    return trimMultilineText(learningState, FULLAUTO_LEARNING_STATE_MAX_CHARS);
  } finally {
    activeRequest.release();
  }
}

async function rewriteFullAutoLearningState(params: {
  sessionId: string;
  session: Session;
  result: GatewayChatResult;
  state: FullAutoRuntimeState;
}): Promise<void> {
  const { session, sessionId, result, state } = params;
  const workspace = getFullAutoWorkspaceState(session);
  fs.mkdirSync(path.dirname(workspace.learningsPath), { recursive: true });
  if (!workspace.learningsExists) {
    seedFullAutoWorkspaceState(session, session.full_auto_prompt);
  }

  const nextState = await generateFullAutoLearningState({
    sessionId,
    session,
    result,
    state,
  });
  if (!nextState) return;

  fs.writeFileSync(workspace.learningsPath, `${nextState.trim()}\n`, 'utf8');
  markFullAutoProgress(sessionId, state, 'learning-subagent:complete');
}

export function buildFullAutoOperatingContract(
  session: Session,
  mode: 'background' | 'supervised',
): string {
  const workspace = getFullAutoWorkspaceState(session);
  const lines = [
    'FULLAUTO mode is active for this session.',
    mode === 'supervised'
      ? 'The latest user message is a supervised intervention. Respond to it directly, adapt the plan, and then continue the broader loop unless the user explicitly disables full-auto.'
      : 'Do not stop after one update. After each meaningful step, choose the next best step and keep going without waiting for another nudge.',
    'Stop only if the human explicitly says `/stop` or `fullauto off`, or if a hard safety/approval boundary blocks further action.',
    'After meaningful work, briefly self-evaluate: what changed, what failed, and what to do next.',
    'After each successful turn, a separate learning-writer subagent will rewrite the active learning-state file from your work. Make your output concrete enough for that handoff.',
    workspace.goalExists
      ? `Use \`${path.relative(workspace.workspacePath, workspace.goalPath)}\` as the high-level objective anchor and re-read it before major pivots.`
      : 'If the task has a durable multi-step objective, create or refresh the current goal file to keep the loop aligned.',
    workspace.learningsExists
      ? `Keep \`${path.relative(workspace.workspacePath, workspace.learningsPath)}\` aligned with the current state of the run; prefer updating durable state over repeating the same work.`
      : 'Create and maintain the current learning-state file when the task spans multiple cycles.',
    'If you are repeating yourself or not making progress, change tactic instead of looping on the same action.',
  ];
  return lines.join('\n');
}

function buildFullAutoTurnPrompt(session: Session): string {
  return [
    resolveFullAutoPrompt(session),
    '',
    'Durable goal state:',
    readFullAutoGoalPromptBlock(session),
    '',
    'Current learning state:',
    readFullAutoLearningsPromptBlock(session),
    '',
    'Recent supervised interventions:',
    readRecentFullAutoInterventions(session),
    '',
    'FULLAUTO mode instructions:',
    '- Continue autonomously without waiting for permission.',
    '- After each meaningful step, decide the next best step and keep going.',
    '- Briefly self-evaluate: what changed, what failed, and what to do next.',
    ...buildFullAutoOperatingContract(session, 'background')
      .split('\n')
      .map((line) => `- ${line}`),
  ].join('\n');
}

function formatFullAutoRuntimeTimestamp(value: number | null): string {
  if (!value || !Number.isFinite(value)) return 'n/a';
  return new Date(value).toISOString();
}

function describeFullAutoRuntimeState(sessionId: string): string {
  const state = fullAutoRuntimeBySession.get(sessionId);
  if (!state) return 'idle';
  if (state.running) return 'running';
  if (state.timer) return 'scheduled';
  return 'armed';
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

function hasPendingApproval(result: GatewayChatResult): boolean {
  return (result.toolExecutions || []).some(
    (execution) => execution.approvalDecision === 'required',
  );
}

function markFullAutoProgress(
  sessionId: string,
  state: FullAutoRuntimeState,
  label: string,
): void {
  if (!isCurrentFullAutoRuntimeState(sessionId, state)) return;
  state.lastProgressAt = Date.now();
  state.lastProgressLabel = label.trim() || null;
}

function buildFullAutoContinuationRequest(
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

function startFullAutoWatchdog(params: {
  sessionId: string;
  state: FullAutoRuntimeState;
  runToken: number;
}): void {
  clearFullAutoWatchdog(params.sessionId);
  if (FULLAUTO_STALL_TIMEOUT_MS <= 0) return;
  const pollMs = Math.max(1_000, FULLAUTO_STALL_POLL_MS);
  params.state.watchdogTimer = setInterval(() => {
    if (
      !isCurrentFullAutoRuntimeState(params.sessionId, params.state) ||
      !params.state.running ||
      params.state.activeRunToken !== params.runToken
    ) {
      clearFullAutoWatchdog(params.sessionId);
      return;
    }

    const lastProgressAt =
      params.state.lastProgressAt ?? params.state.lastTurnStartedAt;
    if (!lastProgressAt) return;
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs < FULLAUTO_STALL_TIMEOUT_MS) return;

    params.state.watchdogInterruptedRunToken = params.runToken;
    params.state.consecutiveStalls += 1;
    params.state.lastInterventionAt = Date.now();
    clearFullAutoWatchdog(params.sessionId);
    logger.warn(
      {
        sessionId: params.sessionId,
        runToken: params.runToken,
        idleMs,
        lastProgressLabel: params.state.lastProgressLabel,
        consecutiveStalls: params.state.consecutiveStalls,
      },
      'Full-auto watchdog interrupting stalled turn',
    );
    interruptGatewaySessionExecution(params.sessionId);
  }, pollMs);
}

async function recoverFullAutoAfterWatchdog(params: {
  sessionId: string;
  session: Session;
  state: FullAutoRuntimeState;
}): Promise<void> {
  if (params.state.consecutiveStalls >= FULLAUTO_MAX_CONSECUTIVE_STALLS) {
    await disableFullAutoSession({
      sessionId: params.sessionId,
      reason: `Stall watchdog interrupted ${FULLAUTO_MAX_CONSECUTIVE_STALLS} consecutive turns without recovery.`,
      notify: true,
      channelId: params.session.channel_id,
      onProactiveMessage: params.state.onProactiveMessage,
    });
    return;
  }

  logger.info(
    {
      sessionId: params.sessionId,
      consecutiveStalls: params.state.consecutiveStalls,
      recoveryDelayMs: FULLAUTO_STALL_RECOVERY_DELAY_MS,
    },
    'Full-auto watchdog scheduled recovery turn',
  );
  scheduleFullAutoContinuation({
    session: params.session,
    req: buildFullAutoContinuationRequest(params.session, params.state),
    delayMs: FULLAUTO_STALL_RECOVERY_DELAY_MS,
  });
}

async function deliverFullAutoMessage(params: {
  sessionId: string;
  channelId: string;
  text: string;
  source: string;
  artifacts?: ArtifactMetadata[];
  onProactiveMessage?:
    | ((message: ProactiveMessagePayload) => void | Promise<void>)
    | null;
}): Promise<void> {
  const trimmed = params.text.trim();
  if (!trimmed) return;
  if (params.onProactiveMessage) {
    try {
      await params.onProactiveMessage({
        text: trimmed,
        artifacts: params.artifacts,
      });
      return;
    } catch (err) {
      logger.warn(
        { sessionId: params.sessionId, channelId: params.channelId, err },
        'Full-auto proactive callback failed; falling back to queue',
      );
    }
  }

  const { queued, dropped } = enqueueProactiveMessage(
    params.channelId,
    trimmed,
    params.source,
    MAX_QUEUED_FULLAUTO_MESSAGES,
  );
  logger.info(
    {
      sessionId: params.sessionId,
      channelId: params.channelId,
      source: params.source,
      queued,
      dropped,
      artifactCount: params.artifacts?.length || 0,
    },
    'Queued full-auto proactive message',
  );
}

export async function disableFullAutoSession(params: {
  sessionId: string;
  reason?: string | null;
  notify?: boolean;
  channelId?: string;
  onProactiveMessage?:
    | ((message: ProactiveMessagePayload) => void | Promise<void>)
    | null;
}): Promise<void> {
  updateSessionFullAuto(params.sessionId, {
    enabled: false,
    prompt: null,
    startedAt: null,
  });
  const state = fullAutoRuntimeBySession.get(params.sessionId);
  invalidateFullAutoRuntimeState(params.sessionId);
  if (!params.notify) return;
  const session = memoryService.getSessionById(params.sessionId);
  const channelId = params.channelId || session?.channel_id;
  if (!channelId) return;
  const detail =
    typeof params.reason === 'string' && params.reason.trim()
      ? ` ${params.reason.trim()}`
      : '';
  await deliverFullAutoMessage({
    sessionId: params.sessionId,
    channelId,
    text: `Full-auto mode disabled.${detail}`,
    source: 'fullauto',
    onProactiveMessage: params.onProactiveMessage ?? state?.onProactiveMessage,
  });
}

function isFullAutoCostCapExceeded(sessionId: string): {
  exceeded: boolean;
  reason?: string;
} {
  if (
    FULLAUTO_MAX_SESSION_COST_USD <= 0 &&
    FULLAUTO_MAX_SESSION_TOTAL_TOKENS <= 0
  ) {
    return { exceeded: false };
  }

  const totals = getSessionUsageTotals(sessionId);
  if (
    FULLAUTO_MAX_SESSION_COST_USD > 0 &&
    totals.total_cost_usd >= FULLAUTO_MAX_SESSION_COST_USD
  ) {
    return {
      exceeded: true,
      reason: `Session cost cap reached ($${totals.total_cost_usd.toFixed(4)} >= $${FULLAUTO_MAX_SESSION_COST_USD.toFixed(4)}).`,
    };
  }
  if (
    FULLAUTO_MAX_SESSION_TOTAL_TOKENS > 0 &&
    totals.total_tokens >= FULLAUTO_MAX_SESSION_TOTAL_TOKENS
  ) {
    return {
      exceeded: true,
      reason: `Session token cap reached (${formatCompactNumber(totals.total_tokens)} >= ${formatCompactNumber(FULLAUTO_MAX_SESSION_TOTAL_TOKENS)}).`,
    };
  }
  return { exceeded: false };
}

export function buildFullAutoStatusLines(session: Session): string[] {
  const state = fullAutoRuntimeBySession.get(session.id);
  const prompt = resolveFullAutoPrompt(session);
  const workspace = getFullAutoWorkspaceState(session);
  return [
    `Enabled: ${isFullAutoEnabled(session) ? 'yes' : 'no'}`,
    `State: ${describeFullAutoRuntimeState(session.id)}`,
    `Prompt: ${abbreviateForUser(prompt, FULLAUTO_STATUS_PROMPT_MAX_CHARS)}`,
    `Started: ${session.full_auto_started_at || 'n/a'}`,
    `Turns: ${state?.turns ?? 0}/${FULLAUTO_MAX_CONSECUTIVE_TURNS}`,
    `Consecutive errors: ${state?.consecutiveErrors ?? 0}/${FULLAUTO_MAX_CONSECUTIVE_ERRORS}`,
    `Consecutive stalls: ${state?.consecutiveStalls ?? 0}/${FULLAUTO_MAX_CONSECUTIVE_STALLS}`,
    `Cooldown: ${FULLAUTO_COOLDOWN_MS}ms`,
    `Stall timeout: ${FULLAUTO_STALL_TIMEOUT_MS}ms`,
    `Last progress: ${formatFullAutoRuntimeTimestamp(state?.lastProgressAt ?? null)}`,
    `Last intervention: ${formatFullAutoRuntimeTimestamp(state?.lastInterventionAt ?? null)}`,
    `Run ID: ${workspace.runId}`,
    `${path.relative(workspace.workspacePath, workspace.goalPath)}: ${workspace.goalExists ? 'present' : 'missing'}`,
    `${path.relative(workspace.workspacePath, workspace.learningsPath)}: ${workspace.learningsExists ? 'present' : 'missing'}`,
    `${path.relative(workspace.workspacePath, workspace.runLogPath)}: ${workspace.runLogExists ? 'present' : 'missing'}`,
    `Ralph: ${formatRalphIterations(resolveSessionRalphIterations(session))}`,
    `Never auto-approve: ${FULLAUTO_NEVER_APPROVE_TOOLS.join(', ') || '(none)'}`,
  ];
}

export function enableFullAutoSession(params: {
  session: Session;
  req: GatewayCommandRequest;
  prompt: string | null;
}): {
  session: Session;
  seeded: {
    goalCreated: boolean;
    learningsCreated: boolean;
    runLogCreated: boolean;
  };
} {
  invalidateFullAutoRuntimeState(params.session.id);
  updateSessionFullAuto(params.session.id, {
    enabled: true,
    prompt: params.prompt,
    startedAt: new Date().toISOString(),
  });
  const refreshed =
    memoryService.getSessionById(params.session.id) ?? params.session;
  const seeded = seedFullAutoWorkspaceState(refreshed, params.prompt);
  const state = getOrCreateFullAutoRuntimeState(refreshed.id);
  state.turns = 0;
  state.consecutiveErrors = 0;
  state.consecutiveStalls = 0;
  state.lastProgressAt = null;
  state.lastProgressLabel = null;
  state.lastInterventionAt = null;
  state.lastTurnStartedAt = null;
  state.watchdogInterruptedRunToken = null;
  syncFullAutoRuntimeContext(refreshed.id, {
    guildId: params.req.guildId,
    userId: params.req.userId ?? FULLAUTO_DEFAULT_USER_ID,
    username: params.req.username ?? FULLAUTO_DEFAULT_USERNAME,
    chatbotId: refreshed.chatbot_id,
    model: refreshed.model,
    enableRag: refreshed.enable_rag === 1,
    onProactiveMessage: null,
  });
  appendFullAutoRunLogEntry({
    session: refreshed,
    heading: 'run-started',
    lines: [
      `- prompt: ${resolveFullAutoPrompt(refreshed)}`,
      `- source: ${params.req.args[0] || 'fullauto'}`,
    ],
  });
  scheduleFullAutoContinuation({
    session: refreshed,
    req: buildFullAutoContinuationRequest(refreshed, state),
    delayMs: FULLAUTO_COOLDOWN_MS,
  });
  return { session: refreshed, seeded };
}

export function maybeScheduleFullAutoAfterSuccess(params: {
  session: Session;
  req: FullAutoRequestContext;
  result: GatewayChatResult;
}): void {
  const session =
    memoryService.getSessionById(params.session.id) ?? params.session;
  if (!isFullAutoEnabled(session)) return;
  if (hasPendingApproval(params.result)) return;
  if (params.req.source === 'fullauto') {
    return;
  }
  scheduleFullAutoContinuation({
    session,
    req: {
      guildId: params.req.guildId,
      userId: params.req.userId,
      username: params.req.username ?? null,
      chatbotId: params.req.chatbotId ?? session.chatbot_id,
      model: params.req.model ?? session.model,
      enableRag: params.req.enableRag ?? session.enable_rag === 1,
      onProactiveMessage: params.req.onProactiveMessage,
    },
  });
}

function scheduleFullAutoContinuation(params: {
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
    void runFullAutoTurn(params.session.id);
  }, delayMs);
}

export function resumeEnabledFullAutoSessions(): number {
  if (fullAutoStartupResumed) return 0;
  fullAutoStartupResumed = true;

  const sessions = getEnabledFullAutoSessions();
  for (const [index, session] of sessions.entries()) {
    seedFullAutoWorkspaceState(session, session.full_auto_prompt);
    const state = syncFullAutoRuntimeContext(session.id, {
      guildId: session.guild_id,
      userId: FULLAUTO_DEFAULT_USER_ID,
      username: FULLAUTO_DEFAULT_USERNAME,
      chatbotId: session.chatbot_id,
      model: session.model,
      enableRag: session.enable_rag === 1,
      onProactiveMessage: null,
    });
    scheduleFullAutoContinuation({
      session,
      req: buildFullAutoContinuationRequest(session, state),
      delayMs: FULLAUTO_RESUME_ON_BOOT_DELAY_MS + index * 250,
    });
  }

  if (sessions.length > 0) {
    logger.info(
      { count: sessions.length },
      'Resumed persisted full-auto sessions on gateway startup',
    );
  }
  return sessions.length;
}

async function runFullAutoTurn(sessionId: string): Promise<void> {
  let session = memoryService.getSessionById(sessionId);
  if (!session || !isFullAutoEnabled(session)) {
    clearFullAutoRuntimeState(sessionId);
    return;
  }

  const state = getOrCreateFullAutoRuntimeState(sessionId);
  if (state.running) return;
  if (state.turns >= FULLAUTO_MAX_CONSECUTIVE_TURNS) {
    await disableFullAutoSession({
      sessionId,
      reason: `Safety cap reached after ${FULLAUTO_MAX_CONSECUTIVE_TURNS} consecutive turns.`,
      notify: true,
      channelId: session.channel_id,
      onProactiveMessage: state.onProactiveMessage,
    });
    return;
  }
  const capCheck = isFullAutoCostCapExceeded(sessionId);
  if (capCheck.exceeded) {
    await disableFullAutoSession({
      sessionId,
      reason: capCheck.reason,
      notify: true,
      channelId: session.channel_id,
      onProactiveMessage: state.onProactiveMessage,
    });
    return;
  }
  if (!isWithinActiveHours()) {
    logger.info(
      { sessionId, activeHours: proactiveWindowLabel() },
      'Full-auto paused outside active hours',
    );
    scheduleFullAutoContinuation({
      session,
      req: buildFullAutoContinuationRequest(session, state),
      delayMs: FULLAUTO_OUTSIDE_HOURS_DELAY_MS,
    });
    return;
  }

  state.running = true;
  state.activeRunToken = nextFullAutoRunToken++;
  state.lastTurnStartedAt = Date.now();
  state.lastProgressAt = state.lastTurnStartedAt;
  state.lastProgressLabel = 'turn-start';
  state.watchdogInterruptedRunToken = null;
  startFullAutoWatchdog({
    sessionId,
    state,
    runToken: state.activeRunToken,
  });
  const maxAttempts = PROACTIVE_AUTO_RETRY_ENABLED
    ? PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS
    : 1;
  let attempt = 0;
  let delayMs = PROACTIVE_AUTO_RETRY_BASE_DELAY_MS;
  let lastError = 'Unknown full-auto error';
  let lastClassification: GatewayErrorClass = 'unknown';
  const runToken = state.activeRunToken;
  const { handleGatewayMessage } = requireFullAutoHost();

  try {
    while (attempt < maxAttempts) {
      attempt += 1;
      session = memoryService.getSessionById(sessionId);
      if (!session || !isFullAutoEnabled(session)) return;

      const result = await handleGatewayMessage({
        sessionId,
        guildId: state.guildId,
        channelId: session.channel_id,
        userId: state.userId,
        username: state.username || FULLAUTO_DEFAULT_USERNAME,
        content: buildFullAutoTurnPrompt(session),
        chatbotId: state.chatbotId ?? session.chatbot_id,
        model: state.model ?? session.model,
        enableRag: state.enableRag ?? session.enable_rag === 1,
        onTextDelta: (delta) => {
          if (!delta) return;
          markFullAutoProgress(sessionId, state, 'text');
        },
        onToolProgress: (event) => {
          markFullAutoProgress(
            sessionId,
            state,
            `${event.toolName}:${event.phase}`,
          );
        },
        onProactiveMessage: state.onProactiveMessage ?? undefined,
        source: 'fullauto',
      });

      if (!isCurrentFullAutoRuntimeState(sessionId, state)) {
        return;
      }
      if (state.watchdogInterruptedRunToken === runToken) {
        state.watchdogInterruptedRunToken = null;
        await recoverFullAutoAfterWatchdog({ sessionId, session, state });
        return;
      }

      if (result.status === 'success') {
        if (hasPendingApproval(result)) {
          await disableFullAutoSession({
            sessionId,
            reason:
              'A tool still requires manual approval and is not eligible for automatic approval.',
            notify: true,
            channelId: session.channel_id,
            onProactiveMessage: state.onProactiveMessage,
          });
          return;
        }

        await rewriteFullAutoLearningState({
          sessionId,
          session,
          result,
          state,
        });
        if (!isCurrentFullAutoRuntimeState(sessionId, state)) {
          return;
        }
        if (state.watchdogInterruptedRunToken === runToken) {
          state.watchdogInterruptedRunToken = null;
          await recoverFullAutoAfterWatchdog({ sessionId, session, state });
          return;
        }
        session = memoryService.getSessionById(sessionId) ?? session;
        if (!isFullAutoEnabled(session)) {
          return;
        }
        if (!isSilentReply(result.result || '')) {
          await deliverFullAutoMessage({
            sessionId,
            channelId: session.channel_id,
            text: String(result.result || '').trim(),
            source: 'fullauto',
            artifacts: result.artifacts,
            onProactiveMessage: state.onProactiveMessage,
          });
        }
        if (!isCurrentFullAutoRuntimeState(sessionId, state)) {
          return;
        }

        appendFullAutoRunLogEntry({
          session,
          heading: `turn-${state.turns + 1}`,
          lines: [
            `- source: fullauto`,
            `- tools: ${[...new Set(result.toolsUsed || [])].join(', ') || '(none)'}`,
            `- result: ${
              String(result.result || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, FULLAUTO_RUN_LOG_RESULT_MAX_CHARS) ||
              '(no visible result)'
            }`,
          ],
        });

        state.turns += 1;
        state.consecutiveErrors = 0;
        state.consecutiveStalls = 0;
        markFullAutoProgress(sessionId, state, 'turn-success');
        const activeSession =
          memoryService.getSessionById(sessionId) ?? session;
        if (
          isCurrentFullAutoRuntimeState(sessionId, state) &&
          isFullAutoEnabled(activeSession)
        ) {
          scheduleFullAutoContinuation({
            session: activeSession,
            req: buildFullAutoContinuationRequest(activeSession, state),
          });
        }
        return;
      }

      lastError = result.error || 'Unknown full-auto error';
      lastClassification = classifyGatewayError(lastError);
      if (lastClassification === 'transient' && attempt < maxAttempts) {
        await sleep(delayMs);
        if (!isCurrentFullAutoRuntimeState(sessionId, state)) {
          return;
        }
        if (state.watchdogInterruptedRunToken === runToken) {
          state.watchdogInterruptedRunToken = null;
          await recoverFullAutoAfterWatchdog({ sessionId, session, state });
          return;
        }
        delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
        continue;
      }
      break;
    }

    state.consecutiveErrors += 1;
    const shouldDisable =
      lastClassification === 'permanent' ||
      state.consecutiveErrors >= FULLAUTO_MAX_CONSECUTIVE_ERRORS;
    if (shouldDisable) {
      const activeSession = session ?? memoryService.getSessionById(sessionId);
      if (!activeSession) return;
      await disableFullAutoSession({
        sessionId,
        reason: lastError,
        notify: true,
        channelId: activeSession.channel_id,
        onProactiveMessage: state.onProactiveMessage,
      });
      return;
    }

    logger.warn(
      {
        sessionId,
        error: lastError,
        consecutiveErrors: state.consecutiveErrors,
      },
      'Full-auto turn failed but remains enabled',
    );
    const activeSession = session ?? memoryService.getSessionById(sessionId);
    if (!activeSession) return;
    scheduleFullAutoContinuation({
      session: activeSession,
      req: buildFullAutoContinuationRequest(activeSession, state),
      delayMs: FULLAUTO_COOLDOWN_MS,
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    if (!isCurrentFullAutoRuntimeState(sessionId, state)) {
      return;
    }
    if (state.watchdogInterruptedRunToken === runToken) {
      state.watchdogInterruptedRunToken = null;
      const activeSession = session ?? memoryService.getSessionById(sessionId);
      if (!activeSession) return;
      await recoverFullAutoAfterWatchdog({
        sessionId,
        session: activeSession,
        state,
      });
      return;
    }
    state.consecutiveErrors += 1;
    const shouldDisable =
      classifyGatewayError(errorText) === 'permanent' ||
      state.consecutiveErrors >= FULLAUTO_MAX_CONSECUTIVE_ERRORS;
    if (shouldDisable) {
      const activeSession = session ?? memoryService.getSessionById(sessionId);
      if (!activeSession) return;
      await disableFullAutoSession({
        sessionId,
        reason: errorText,
        notify: true,
        channelId: activeSession.channel_id,
        onProactiveMessage: state.onProactiveMessage,
      });
    } else {
      logger.warn(
        { sessionId, err, consecutiveErrors: state.consecutiveErrors },
        'Full-auto turn crashed but remains enabled',
      );
      const activeSession = session ?? memoryService.getSessionById(sessionId);
      if (!activeSession) return;
      scheduleFullAutoContinuation({
        session: activeSession,
        req: buildFullAutoContinuationRequest(activeSession, state),
        delayMs: FULLAUTO_COOLDOWN_MS,
      });
    }
  } finally {
    if (isCurrentFullAutoRuntimeState(sessionId, state)) {
      clearFullAutoWatchdog(sessionId);
      state.running = false;
      state.activeRunToken = null;
    }
    if (!memoryService.getSessionById(sessionId)?.full_auto_enabled) {
      clearFullAutoRuntimeState(sessionId);
    }
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
