import { CronExpressionParser } from 'cron-parser';

import {
  APP_VERSION,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  HYBRIDAI_MODELS,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_DELEGATION_MAX_DEPTH,
  PROACTIVE_DELEGATION_MAX_PER_TURN,
} from './config.js';
import { runAgent } from './agent.js';
import { getActiveContainerCount } from './container-runner.js';
import {
  clearSessionHistory,
  createTask,
  deleteTask,
  getAllSessions,
  getConversationHistory,
  getOrCreateSession,
  getSessionCount,
  getTasksForSession,
  logAudit,
  storeMessage,
  toggleTask,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
} from './db.js';
import { emitToolExecutionAuditEvents, makeAuditRunId, recordAuditEvent } from './audit-events.js';
import { fetchHybridAIBots } from './hybridai-bots.js';
import { logger } from './logger.js';
import { rearmScheduler } from './scheduler.js';
import { maybeCompactSession } from './session-maintenance.js';
import { appendSessionTranscript } from './session-transcripts.js';
import { processSideEffects } from './side-effects.js';
import { expandSkillInvocation } from './skills.js';
import {
  renderGatewayCommand,
  type GatewayChatRequestBody,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayStatus,
} from './gateway-types.js';
import type { DelegationSideEffect, DelegationTaskSpec, ScheduledTask, StoredMessage, ToolProgressEvent } from './types.js';
import { ensureBootstrapFiles } from './workspace.js';
import { buildConversationContext } from './conversation.js';
import { runIsolatedScheduledTask } from './scheduled-task-runner.js';
import { delegationQueueStatus, enqueueDelegation } from './delegation-manager.js';

const BOT_CACHE_TTL = 300_000; // 5 minutes
const MAX_HISTORY_MESSAGES = 40;
const BASE_SUBAGENT_ALLOWED_TOOLS = [
  'read',
  'write',
  'edit',
  'delete',
  'glob',
  'grep',
  'bash',
  'session_search',
  'web_fetch',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'browser_pdf',
  'browser_close',
];
const ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS = [...BASE_SUBAGENT_ALLOWED_TOOLS, 'delegate'];
const MAX_DELEGATION_TASKS = 6;
const MAX_DELEGATION_USER_CHARS = 500;
const TRANSIENT_DELEGATION_ERROR_PATTERNS: RegExp[] = [
  /econnreset/i,
  /etimedout/i,
  /429/i,
  /5\d\d/i,
  /network/i,
  /socket/i,
  /fetch failed/i,
  /temporar/i,
  /rate limit/i,
  /unavailable/i,
];
const PERMANENT_DELEGATION_ERROR_PATTERNS: RegExp[] = [
  /forbidden/i,
  /permission denied/i,
  /unauthorized/i,
  /not found/i,
  /invalid api key/i,
  /blocked by security hook/i,
];

type DelegationMode = 'single' | 'parallel' | 'chain';
type DelegationRunStatus = 'completed' | 'failed' | 'timeout';
type DelegationErrorClass = 'transient' | 'permanent' | 'unknown';

interface NormalizedDelegationTask {
  prompt: string;
  label?: string;
  model: string;
}

interface NormalizedDelegationPlan {
  mode: DelegationMode;
  label?: string;
  tasks: NormalizedDelegationTask[];
}

interface DelegationRunResult {
  status: DelegationRunStatus;
  sessionId: string;
  model: string;
  durationMs: number;
  attempts: number;
  toolsUsed: string[];
  result?: string;
  error?: string;
}

interface DelegationCompletionEntry {
  title: string;
  run: DelegationRunResult;
}

interface DelegationTaskRunInput {
  parentSessionId: string;
  childDepth: number;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  mode: DelegationMode;
  task: NormalizedDelegationTask;
}

export interface GatewayChatRequest {
  sessionId: GatewayChatRequestBody['sessionId'];
  guildId: GatewayChatRequestBody['guildId'];
  channelId: GatewayChatRequestBody['channelId'];
  userId: GatewayChatRequestBody['userId'];
  username: GatewayChatRequestBody['username'];
  content: GatewayChatRequestBody['content'];
  chatbotId?: GatewayChatRequestBody['chatbotId'];
  model?: GatewayChatRequestBody['model'];
  enableRag?: GatewayChatRequestBody['enableRag'];
  onToolProgress?: (event: ToolProgressEvent) => void;
  onProactiveMessage?: (text: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export type { GatewayChatResult, GatewayCommandRequest, GatewayCommandResult, GatewayStatus };
export { renderGatewayCommand };

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function infoCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

export function getGatewayStatus(): GatewayStatus {
  return {
    status: 'ok',
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    sessions: getSessionCount(),
    activeContainers: getActiveContainerCount(),
    defaultModel: HYBRIDAI_MODEL,
    ragDefault: HYBRIDAI_ENABLE_RAG,
    timestamp: new Date().toISOString(),
  };
}

export function getGatewayHistory(sessionId: string, limit = MAX_HISTORY_MESSAGES): StoredMessage[] {
  return getConversationHistory(sessionId, Math.max(1, Math.min(limit, 200))).reverse();
}

function extractDelegationDepth(sessionId: string): number {
  const match = sessionId.match(/^delegate:d(\d+):/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextDelegationSessionId(parentSessionId: string, nextDepth: number): string {
  const safeParent = parentSessionId.replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 48);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `delegate:d${nextDepth}:${safeParent}:${Date.now()}:${nonce}`;
}

function resolveSubagentAllowedTools(depth: number): string[] {
  if (depth < PROACTIVE_DELEGATION_MAX_DEPTH) return ORCHESTRATOR_SUBAGENT_ALLOWED_TOOLS;
  return BASE_SUBAGENT_ALLOWED_TOOLS;
}

function buildSubagentSystemPrompt(params: { depth: number; canDelegate: boolean; mode: DelegationMode }): string {
  const { depth, canDelegate, mode } = params;
  const delegationLine = canDelegate
    ? 'You may delegate further only if absolutely necessary and still within depth/turn limits.'
    : 'You are a leaf subagent. Do not delegate further work.';

  return [
    '# Subagent Context',
    'You are a delegated subagent spawned by a parent agent for one specific task.',
    '',
    '## Identity',
    '- You are not the end-user assistant; you are a focused worker.',
    '- The next user message is a task handoff from the parent agent.',
    '- Your final response is what the parent uses; make it complete and actionable.',
    '',
    '## Mission',
    '- Complete exactly the delegated task and return concrete results.',
    '- Stay scoped to the assigned objective; no unrelated side quests.',
    '',
    '## Runtime',
    `Delegation mode: ${mode}.`,
    `Current delegation depth: ${depth}.`,
    delegationLine,
    '',
    '## Rules',
    '- Do not interact with users directly.',
    '- Do not create schedules or persistent autonomous workflows.',
    'Do not poll or sleep for completion checks; return when the task is complete.',
    '- Use tools only when needed and keep actions minimal and relevant.',
    '',
    '## Output Format (required)',
    'Use this exact section structure in your final response:',
    '## Completed',
    '- What you accomplished.',
    '## Files Touched',
    '- Exact paths read/modified (or "None").',
    '## Key Findings',
    '- The important technical results for the parent.',
    '## Issues / Limits',
    '- Errors, blockers, or confidence caveats (or "None").',
  ].join('\n');
}

function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function abbreviateForUser(text: string, maxChars = MAX_DELEGATION_USER_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function classifyDelegationError(errorText: string): DelegationErrorClass {
  if (PERMANENT_DELEGATION_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) return 'permanent';
  if (TRANSIENT_DELEGATION_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) return 'transient';
  return 'unknown';
}

function inferDelegationStatus(errorText: string): DelegationRunStatus {
  return /timeout|timed out|deadline exceeded/i.test(errorText) ? 'timeout' : 'failed';
}

function normalizeDelegationTask(raw: unknown, fallbackModel: string): NormalizedDelegationTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as DelegationTaskSpec;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;
  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const model = typeof task.model === 'string' && task.model.trim()
    ? task.model.trim()
    : fallbackModel;
  return {
    prompt,
    label: label || undefined,
    model,
  };
}

function normalizeDelegationEffect(effect: DelegationSideEffect, fallbackModel: string): {
  plan?: NormalizedDelegationPlan;
  error?: string;
} {
  const rawMode = typeof effect.mode === 'string' ? effect.mode.trim().toLowerCase() : '';
  const modeRaw: DelegationMode | '' =
    rawMode === 'single' || rawMode === 'parallel' || rawMode === 'chain'
      ? rawMode
      : '';
  if (rawMode && !modeRaw) {
    return { error: 'Invalid delegation mode' };
  }

  const label = typeof effect.label === 'string' ? effect.label.trim() : '';
  const baseModel = typeof effect.model === 'string' && effect.model.trim()
    ? effect.model.trim()
    : fallbackModel;
  const prompt = typeof effect.prompt === 'string' ? effect.prompt.trim() : '';
  const rawTasks = Array.isArray(effect.tasks) ? effect.tasks : [];
  const rawChain = Array.isArray(effect.chain) ? effect.chain : [];

  let mode: DelegationMode;
  if (modeRaw) mode = modeRaw;
  else if (rawChain.length > 0) mode = 'chain';
  else if (rawTasks.length > 0) mode = 'parallel';
  else mode = 'single';

  if (mode === 'single') {
    if (!prompt) return { error: 'Single-mode delegation missing prompt' };
    return {
      plan: {
        mode,
        label: label || undefined,
        tasks: [{ prompt, label: label || undefined, model: baseModel }],
      },
    };
  }

  const sourceTasks = mode === 'parallel' ? rawTasks : rawChain;
  if (sourceTasks.length === 0) {
    return { error: `${mode} delegation requires at least one task` };
  }
  if (sourceTasks.length > MAX_DELEGATION_TASKS) {
    return { error: `${mode} delegation exceeds max tasks (${MAX_DELEGATION_TASKS})` };
  }
  const tasks: NormalizedDelegationTask[] = [];
  for (let i = 0; i < sourceTasks.length; i++) {
    const normalized = normalizeDelegationTask(sourceTasks[i], baseModel);
    if (!normalized) return { error: `${mode} delegation task #${i + 1} is invalid` };
    tasks.push(normalized);
  }
  return {
    plan: {
      mode,
      label: label || undefined,
      tasks,
    },
  };
}

function renderDelegationTaskTitle(mode: DelegationMode, task: NormalizedDelegationTask, index: number, total: number): string {
  if (task.label) return task.label;
  if (mode === 'chain') return `step ${index + 1}/${total}`;
  if (mode === 'parallel') return `task ${index + 1}/${total}`;
  return 'task';
}

function interpolateChainPrompt(prompt: string, previousResult: string): string {
  if (!prompt.includes('{previous}')) return prompt;
  const replacement = previousResult.trim() || '(no previous output)';
  return prompt.replace(/\{previous\}/g, replacement);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDelegationTaskWithRetry(input: DelegationTaskRunInput): Promise<DelegationRunResult> {
  const {
    parentSessionId,
    childDepth,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    mode,
    task,
  } = input;
  const allowedTools = resolveSubagentAllowedTools(childDepth);
  const canDelegate = allowedTools.includes('delegate');
  const maxAttempts = PROACTIVE_AUTO_RETRY_ENABLED ? PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS : 1;
  let attempt = 0;
  let delayMs = PROACTIVE_AUTO_RETRY_BASE_DELAY_MS;
  let lastError = 'Delegation failed with unknown error';
  let lastStatus: DelegationRunStatus = 'failed';
  let lastDuration = 0;
  let lastSessionId = nextDelegationSessionId(parentSessionId, childDepth);
  let lastToolsUsed: string[] = [];

  while (attempt < maxAttempts) {
    attempt += 1;
    const sessionId = nextDelegationSessionId(parentSessionId, childDepth);
    lastSessionId = sessionId;
    const startedAt = Date.now();
    try {
      const output = await runAgent(
        sessionId,
        [
          { role: 'system', content: buildSubagentSystemPrompt({ depth: childDepth, canDelegate, mode }) },
          { role: 'user', content: task.prompt },
        ],
        chatbotId,
        enableRag,
        task.model,
        agentId,
        channelId,
        undefined,
        allowedTools,
      );
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      lastToolsUsed = output.toolsUsed || [];

      if (output.status === 'success' && output.result?.trim()) {
        return {
          status: 'completed',
          sessionId,
          model: task.model,
          durationMs,
          attempts: attempt,
          toolsUsed: output.toolsUsed || [],
          result: output.result.trim(),
        };
      }

      const errorText = output.error || 'Delegated run returned empty output.';
      lastError = errorText;
      lastStatus = inferDelegationStatus(errorText);
      const classification = classifyDelegationError(errorText);
      const shouldRetry = classification === 'transient' && attempt < maxAttempts;
      if (!shouldRetry) break;

      logger.warn(
        { parentSessionId, sessionId, attempt, maxAttempts, delayMs, errorText },
        'Delegation retry scheduled after transient error',
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      lastDuration = durationMs;
      const errorText = err instanceof Error ? err.message : String(err);
      lastError = errorText;
      lastStatus = inferDelegationStatus(errorText);
      const classification = classifyDelegationError(errorText);
      const shouldRetry = classification === 'transient' && attempt < maxAttempts;
      if (!shouldRetry) break;
      logger.warn(
        { parentSessionId, sessionId, attempt, maxAttempts, delayMs, errorText },
        'Delegation retry scheduled after transient exception',
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, PROACTIVE_AUTO_RETRY_MAX_DELAY_MS);
    }
  }

  return {
    status: lastStatus,
    sessionId: lastSessionId,
    model: task.model,
    durationMs: lastDuration,
    attempts: attempt,
    toolsUsed: lastToolsUsed,
    error: lastError,
  };
}

function formatDelegationCompletion(params: {
  mode: DelegationMode;
  label?: string;
  entries: DelegationCompletionEntry[];
  totalDurationMs: number;
}): { forUser: string; forLLM: string } {
  const { mode, label, entries, totalDurationMs } = params;
  const completedCount = entries.filter((entry) => entry.run.status === 'completed').length;
  const failedCount = entries.length - completedCount;
  const overallStatus = failedCount === 0 ? 'completed' : completedCount === 0 ? 'failed' : 'partial';
  const heading = label?.trim() ? `[Delegate: ${label.trim()}]` : `[Delegate ${mode}]`;

  const userLines = [
    `${heading} ${overallStatus} (${completedCount}/${entries.length} completed, ${formatDurationMs(totalDurationMs)}).`,
  ];
  for (const entry of entries) {
    if (entry.run.status === 'completed') {
      userLines.push(`- ${entry.title}: ${abbreviateForUser(entry.run.result || '')}`);
    } else {
      userLines.push(`- ${entry.title}: ${entry.run.status} (${abbreviateForUser(entry.run.error || 'Unknown error')})`);
    }
  }

  const llmLines = [
    `${heading} ${overallStatus}`,
    `mode: ${mode}`,
    `completed: ${completedCount}/${entries.length}`,
    `duration_ms_total: ${totalDurationMs}`,
    '',
  ];
  for (const entry of entries) {
    llmLines.push(`## ${entry.title}`);
    llmLines.push(`status: ${entry.run.status}`);
    llmLines.push(`session_id: ${entry.run.sessionId}`);
    llmLines.push(`model: ${entry.run.model}`);
    llmLines.push(`duration_ms: ${entry.run.durationMs}`);
    llmLines.push(`attempts: ${entry.run.attempts}`);
    if (entry.run.toolsUsed.length > 0) {
      llmLines.push(`tools_used: ${entry.run.toolsUsed.join(', ')}`);
    }
    if (entry.run.status === 'completed') {
      llmLines.push('');
      llmLines.push(entry.run.result || '(empty result)');
    } else {
      llmLines.push(`error: ${entry.run.error || 'Unknown error'}`);
    }
    llmLines.push('');
  }

  return {
    forUser: abbreviateForUser(userLines.join('\n')),
    forLLM: llmLines.join('\n').trimEnd(),
  };
}

async function publishDelegationCompletion(params: {
  parentSessionId: string;
  channelId: string;
  agentId: string;
  forLLM: string;
  forUser: string;
  onProactiveMessage?: (text: string) => void | Promise<void>;
}): Promise<void> {
  const {
    parentSessionId,
    channelId,
    agentId,
    forLLM,
    forUser,
    onProactiveMessage,
  } = params;

  storeMessage(parentSessionId, 'assistant', null, 'assistant', forLLM);
  appendSessionTranscript(agentId, {
    sessionId: parentSessionId,
    channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: forLLM,
  });

  if (onProactiveMessage) {
    await onProactiveMessage(forUser);
    return;
  }
  logger.info({ parentSessionId, message: forUser }, 'Delegation completion (no proactive channel callback)');
}

function enqueueDelegationFromSideEffect(params: {
  plan: NormalizedDelegationPlan;
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  onProactiveMessage?: (text: string) => void | Promise<void>;
  parentDepth: number;
}): void {
  const {
    plan,
    parentSessionId,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    onProactiveMessage,
    parentDepth,
  } = params;
  const childDepth = parentDepth + 1;
  if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
    logger.info({ parentSessionId, childDepth, maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH }, 'Delegation skipped — depth limit reached');
    return;
  }

  const jobId = `${parentSessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  enqueueDelegation({
    id: jobId,
    run: async () => {
      const startedAt = Date.now();
      const entries: DelegationCompletionEntry[] = [];

      if (plan.mode === 'parallel') {
        const runs = await Promise.all(plan.tasks.map(async (task, index) => {
          const run = await runDelegationTaskWithRetry({
            parentSessionId,
            childDepth,
            channelId,
            chatbotId,
            enableRag,
            agentId,
            mode: plan.mode,
            task,
          });
          return {
            title: renderDelegationTaskTitle(plan.mode, task, index, plan.tasks.length),
            run,
          } as DelegationCompletionEntry;
        }));
        entries.push(...runs);
      } else if (plan.mode === 'chain') {
        let previousResult = '';
        for (let i = 0; i < plan.tasks.length; i++) {
          const task = plan.tasks[i];
          const run = await runDelegationTaskWithRetry({
            parentSessionId,
            childDepth,
            channelId,
            chatbotId,
            enableRag,
            agentId,
            mode: plan.mode,
            task: {
              ...task,
              prompt: interpolateChainPrompt(task.prompt, previousResult),
            },
          });
          entries.push({
            title: renderDelegationTaskTitle(plan.mode, task, i, plan.tasks.length),
            run,
          });
          if (run.status !== 'completed') break;
          previousResult = run.result || '';
        }
      } else {
        const task = plan.tasks[0];
        const run = await runDelegationTaskWithRetry({
          parentSessionId,
          childDepth,
          channelId,
          chatbotId,
          enableRag,
          agentId,
          mode: plan.mode,
          task,
        });
        entries.push({
          title: renderDelegationTaskTitle(plan.mode, task, 0, 1),
          run,
        });
      }

      if (entries.length === 0) {
        logger.warn({ parentSessionId, mode: plan.mode }, 'Delegation produced no entries');
        return;
      }

      const completion = formatDelegationCompletion({
        mode: plan.mode,
        label: plan.label,
        entries,
        totalDurationMs: Date.now() - startedAt,
      });
      await publishDelegationCompletion({
        parentSessionId,
        channelId,
        agentId,
        forLLM: completion.forLLM,
        forUser: completion.forUser,
        onProactiveMessage,
      });
    },
  });
}

export async function handleGatewayMessage(req: GatewayChatRequest): Promise<GatewayChatResult> {
  const startedAt = Date.now();
  const runId = makeAuditRunId('turn');
  const session = getOrCreateSession(req.sessionId, req.guildId, req.channelId);
  const chatbotId = req.chatbotId ?? session.chatbot_id ?? HYBRIDAI_CHATBOT_ID;
  const enableRag = req.enableRag ?? session.enable_rag === 1;
  const model = req.model ?? session.model ?? HYBRIDAI_MODEL;
  const turnIndex = session.message_count + 1;

  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'session.start',
      userId: req.userId,
      channel: req.channelId,
      cwd: process.cwd(),
      model,
      source: 'gateway.chat',
    },
  });
  recordAuditEvent({
    sessionId: req.sessionId,
    runId,
    event: {
      type: 'turn.start',
      turnIndex,
      userInput: req.content,
      username: req.username,
    },
  });

  if (!chatbotId) {
    const error = 'No chatbot configured. Set `hybridai.defaultChatbotId` in config.json or select a bot for this session.';
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'configuration',
        message: error,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error,
    };
  }

  const agentId = chatbotId;
  ensureBootstrapFiles(agentId);

  const history = getConversationHistory(req.sessionId, MAX_HISTORY_MESSAGES);
  const { messages, skills } = buildConversationContext({
    agentId,
    sessionSummary: session.session_summary,
    history,
  });
  messages.push({
    role: 'user',
    content: expandSkillInvocation(req.content, skills),
  });

  try {
    const scheduledTasks: ScheduledTask[] = getTasksForSession(req.sessionId);
    const output = await runAgent(
      req.sessionId,
      messages,
      chatbotId,
      enableRag,
      model,
      agentId,
      req.channelId,
      scheduledTasks,
      undefined,
      req.onToolProgress,
      req.abortSignal,
    );
    const toolExecutions = output.toolExecutions || [];
    emitToolExecutionAuditEvents({
      sessionId: req.sessionId,
      runId,
      toolExecutions,
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'model.usage',
        provider: 'hybridai',
        model,
        durationMs: Date.now() - startedAt,
        toolCallCount: toolExecutions.length,
      },
    });

    const parentDepth = extractDelegationDepth(req.sessionId);
    let acceptedDelegations = 0;
    processSideEffects(output, req.sessionId, req.channelId, {
      onDelegation: (effect) => {
        const normalized = normalizeDelegationEffect(effect, model);
        if (!normalized.plan) {
          logger.warn(
            { sessionId: req.sessionId, error: normalized.error || 'unknown', effect },
            'Delegation skipped — invalid payload',
          );
          return;
        }

        const childDepth = parentDepth + 1;
        if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
          logger.info(
            { sessionId: req.sessionId, childDepth, maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH },
            'Delegation skipped — depth limit reached',
          );
          return;
        }

        const requestedRuns = normalized.plan.tasks.length;
        if (acceptedDelegations + requestedRuns > PROACTIVE_DELEGATION_MAX_PER_TURN) {
          logger.info(
            {
              sessionId: req.sessionId,
              limit: PROACTIVE_DELEGATION_MAX_PER_TURN,
              requestedRuns,
              acceptedDelegations,
            },
            'Delegation skipped — per-turn limit reached',
          );
          return;
        }
        acceptedDelegations += requestedRuns;
        enqueueDelegationFromSideEffect({
          plan: normalized.plan,
          parentSessionId: req.sessionId,
          channelId: req.channelId,
          chatbotId,
          enableRag,
          agentId,
          onProactiveMessage: req.onProactiveMessage,
          parentDepth,
        });
      },
    });

    if (output.status === 'error') {
      const errorMessage = output.error || 'Unknown agent error.';
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'error',
          errorType: 'agent',
          message: errorMessage,
          recoverable: true,
        },
      });
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId: req.sessionId,
        runId,
        event: {
          type: 'session.end',
          reason: 'error',
          stats: {
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: toolExecutions.length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      return {
        status: 'error',
        result: null,
        toolsUsed: output.toolsUsed || [],
        toolExecutions,
        error: errorMessage,
      };
    }

    const resultText = output.result || 'No response from agent.';
    storeMessage(req.sessionId, req.userId, req.username, 'user', req.content);
    storeMessage(req.sessionId, 'assistant', null, 'assistant', resultText);
    appendSessionTranscript(agentId, {
      sessionId: req.sessionId,
      channelId: req.channelId,
      role: 'user',
      userId: req.userId,
      username: req.username,
      content: req.content,
    });
    appendSessionTranscript(agentId, {
      sessionId: req.sessionId,
      channelId: req.channelId,
      role: 'assistant',
      userId: 'assistant',
      username: null,
      content: resultText,
    });

    void maybeCompactSession({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
    }).catch((err) => {
      logger.warn({ sessionId: req.sessionId, err }, 'Background session compaction failed');
    });

    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'completed',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'normal',
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: toolExecutions.length,
          durationMs: Date.now() - startedAt,
        },
      },
    });

    return {
      status: 'success',
      result: resultText,
      toolsUsed: output.toolsUsed || [],
      toolExecutions,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logAudit('error', req.sessionId, { error: errorMsg }, Date.now() - startedAt);
    logger.error({ sessionId: req.sessionId, err }, 'Gateway message handling failed');
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'gateway',
        message: errorMsg,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: req.sessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      toolExecutions: undefined,
      error: errorMsg,
    };
  }
}

export async function runGatewayScheduledTask(
  origSessionId: string,
  channelId: string,
  prompt: string,
  taskId: number,
  onResult: (result: string) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const session = getOrCreateSession(origSessionId, null, channelId);
  const chatbotId = session.chatbot_id || HYBRIDAI_CHATBOT_ID;
  if (!chatbotId) return;
  const model = session.model || HYBRIDAI_MODEL;
  const agentId = chatbotId;

  await runIsolatedScheduledTask({
    taskId,
    prompt,
    channelId,
    chatbotId,
    model,
    agentId,
    onResult,
    onError,
  });
}

export async function handleGatewayCommand(req: GatewayCommandRequest): Promise<GatewayCommandResult> {
  const cmd = (req.args[0] || '').toLowerCase();
  const session = getOrCreateSession(req.sessionId, req.guildId, req.channelId);

  switch (cmd) {
    case 'help': {
      const help = [
        '`bot list` — List available bots',
        '`bot set <id|name>` — Set chatbot for this session',
        '`bot info` — Show current chatbot settings',
        '`model list` — List available models',
        '`model set <name>` — Set model for this session',
        '`model info` — Show current model',
        '`rag [on|off]` — Toggle or set RAG mode',
        '`clear` — Clear session history',
        '`status` — Show runtime status',
        '`sessions` — List active sessions',
        '`schedule add "<cron>" <prompt>` — Add scheduled task',
        '`schedule list` — List scheduled tasks',
        '`schedule remove <id>` — Remove a task',
        '`schedule toggle <id>` — Enable/disable a task',
      ];
      return infoCommand('HybridClaw Commands', help.join('\n'));
    }

    case 'bot': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'list') {
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          if (bots.length === 0) return plainCommand('No bots available.');
          const list = bots.map((b) =>
            `• ${b.name} (${b.id})${b.description ? ` — ${b.description}` : ''}`
          ).join('\n');
          return infoCommand('Available Bots', list);
        } catch (err) {
          return badCommand('Error', `Failed to fetch bots: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (sub === 'set') {
        const requested = req.args.slice(2).join(' ').trim();
        if (!requested) return badCommand('Usage', 'Usage: `bot set <id|name>`');
        let resolvedBotId = requested;
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          const matched = bots.find((b) =>
            b.id === requested || b.name.toLowerCase() === requested.toLowerCase()
          );
          if (matched) resolvedBotId = matched.id;
        } catch {
          // keep user-supplied value when lookup fails
        }
        updateSessionChatbot(session.id, resolvedBotId);
        return plainCommand(`Chatbot set to \`${resolvedBotId}\` for this session.`);
      }

      if (sub === 'info') {
        const botId = session.chatbot_id || HYBRIDAI_CHATBOT_ID || 'Not set';
        let botLabel = botId;
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          const bot = bots.find((b) => b.id === botId);
          if (bot) botLabel = `${bot.name} (${bot.id})`;
        } catch {
          // keep ID fallback
        }
        const model = session.model || HYBRIDAI_MODEL;
        const ragStatus = session.enable_rag ? 'Enabled' : 'Disabled';
        return infoCommand('Bot Info', `Chatbot: ${botLabel}\nModel: ${model}\nRAG: ${ragStatus}`);
      }

      return badCommand('Usage', 'Usage: `bot list|set <id|name>|info`');
    }

    case 'model': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'list') {
        const current = session.model || HYBRIDAI_MODEL;
        const list = HYBRIDAI_MODELS.map((m) =>
          m === current ? `${m} (current)` : m
        ).join('\n');
        return infoCommand('Available Models', list);
      }

      if (sub === 'set') {
        const modelName = req.args[2];
        if (!modelName) return badCommand('Usage', 'Usage: `model set <name>`');
        if (HYBRIDAI_MODELS.length > 0 && !HYBRIDAI_MODELS.includes(modelName)) {
          return badCommand('Unknown Model', `\`${modelName}\` is not in the available models list.`);
        }
        updateSessionModel(session.id, modelName);
        return plainCommand(`Model set to \`${modelName}\` for this session.`);
      }

      if (sub === 'info') {
        const current = session.model || HYBRIDAI_MODEL;
        return infoCommand('Model Info', `Current model: ${current}\nDefault model: ${HYBRIDAI_MODEL}`);
      }

      return badCommand('Usage', 'Usage: `model list|set <name>|info`');
    }

    case 'rag': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'on' || sub === 'off') {
        updateSessionRag(session.id, sub === 'on');
        return plainCommand(`RAG ${sub === 'on' ? 'enabled' : 'disabled'} for this session.`);
      }
      if (!sub) {
        const nextEnabled = session.enable_rag === 0;
        updateSessionRag(session.id, nextEnabled);
        return plainCommand(`RAG ${nextEnabled ? 'enabled' : 'disabled'} for this session.`);
      }
      return badCommand('Usage', 'Usage: `rag [on|off]`');
    }

    case 'clear': {
      const deleted = clearSessionHistory(session.id);
      return infoCommand('Session Cleared', `Deleted ${deleted} messages. Workspace files preserved.`);
    }

    case 'status': {
      const status = getGatewayStatus();
      const delegationStatus = delegationQueueStatus();
      const lines = [
        `Uptime: ${formatUptime(status.uptime)}`,
        `Sessions: ${status.sessions}`,
        `Active Containers: ${status.activeContainers}`,
        `Delegations: ${delegationStatus.active} active / ${delegationStatus.queued} queued`,
        `Default Model: ${status.defaultModel}`,
        `RAG Default: ${status.ragDefault ? 'On' : 'Off'}`,
      ];
      return infoCommand('Status', lines.join('\n'));
    }

    case 'sessions': {
      const sessions = getAllSessions();
      if (sessions.length === 0) return plainCommand('No active sessions.');
      const list = sessions.slice(0, 20).map((s) =>
        `${s.id} — ${s.message_count} msgs, last active ${s.last_active}`
      ).join('\n');
      return infoCommand('Sessions', list);
    }

    case 'schedule': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'add') {
        const rest = req.args.slice(2).join(' ');
        const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
        if (!cronMatch) {
          return badCommand('Usage', 'Usage: `schedule add "<cron>" <prompt>`');
        }
        const [, cronExpr, prompt] = cronMatch;
        try {
          CronExpressionParser.parse(cronExpr);
        } catch {
          return badCommand('Invalid Cron', `\`${cronExpr}\` is not a valid cron expression.`);
        }
        const taskId = createTask(session.id, req.channelId, cronExpr, prompt);
        rearmScheduler();
        return plainCommand(`Task #${taskId} created: \`${cronExpr}\` — ${prompt}`);
      }

      if (sub === 'list') {
        const tasks = getTasksForSession(session.id);
        if (tasks.length === 0) return plainCommand('No scheduled tasks.');
        const list = tasks.map((task) =>
          `#${task.id} ${task.enabled ? 'enabled' : 'disabled'} \`${task.cron_expr}\` — ${task.prompt.slice(0, 60)}`
        ).join('\n');
        return infoCommand('Scheduled Tasks', list);
      }

      if (sub === 'remove') {
        const taskId = parseIntOrNull(req.args[2]);
        if (!taskId) return badCommand('Usage', 'Usage: `schedule remove <id>`');
        deleteTask(taskId);
        rearmScheduler();
        return plainCommand(`Task #${taskId} removed.`);
      }

      if (sub === 'toggle') {
        const taskId = parseIntOrNull(req.args[2]);
        if (!taskId) return badCommand('Usage', 'Usage: `schedule toggle <id>`');
        const tasks = getTasksForSession(session.id);
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return badCommand('Not Found', `Task #${taskId} was not found in this session.`);
        toggleTask(taskId, !Boolean(task.enabled));
        rearmScheduler();
        return plainCommand(`Task #${taskId} ${task.enabled ? 'disabled' : 'enabled'}.`);
      }

      return badCommand('Usage', 'Usage: `schedule add|list|remove|toggle`');
    }

    default:
      return badCommand('Unknown Command', `Unknown command: \`${cmd || '(empty)'}\`.`);
  }
}
