/**
 * Durable turn evidence, shared by worker and gateway. A started call without
 * a result is uncertain and is never replayed here. Unlike IPC replies this
 * journal survives worker replacement with known usage; it grants no tool authority.
 * Executed calls progress proposed → started → result_recorded. Terminal
 * receipts without a start (denials/rejections) never authorize a later start.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeFileAtomic } from './atomic-write.ts';
import type { TokenUsageStats } from './token-usage.ts';
import { validateTokenUsage } from './token-usage.ts';
import type { HistoryMessage } from './tool-history.ts';
import { validateToolHistory } from './tool-history.ts';

type CheckpointMessage = Omit<HistoryMessage, 'content'> & { content: unknown };
type FindLastIndexArray = HistoryMessage[] & {
  findLastIndex(predicate: (entry: HistoryMessage) => boolean): number;
};

export interface TurnCheckpointData {
  version: 1;
  turnId: string;
  messages: HistoryMessage[];
  started: string[];
  assistantText?: string;
  tokenUsage?: TokenUsageStats;
}

import type { RecoveryDisposition } from '@hybridclaw/contracts/agent-io';

export type { RecoveryDisposition };

/** Conversation evidence cannot carry executable approvals or queued effects. */
export interface TurnRecoveryEvidence {
  recovery: RecoveryDisposition & { kind: 'recovered'; turnId: string };
  pendingApproval?: never;
  sideEffects?: never;
  approvalReply?: never;
  status: 'error';
  result: null;
  error: string;
  toolsUsed: string[];
  tokenUsage?: TokenUsageStats;
  toolHistory: HistoryMessage[];
  toolHistoryForReplay: HistoryMessage[];
  toolExecutions: Array<{
    name: string;
    arguments: string;
    toolCallId: string;
    result: string;
    isError: boolean;
    durationMs: number;
  }>;
}
export type TurnRecoveryResult =
  | { kind: 'recovered'; evidence: TurnRecoveryEvidence }
  | { kind: 'refused'; reason: 'missing' | 'run_mismatch' | 'unreadable' };

export function sessionStateKey(sessionId: string): string {
  // lgtm[js/insufficient-password-hash] This is a deterministic session/user
  // lookup key for state files and approval records, never a password/token
  // verifier. Keep identifiers and path separators out of persistent filenames.
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function sessionStatePath(
  workspaceRoot: string,
  sessionId: string,
  name: string,
): string {
  return path.join(
    workspaceRoot,
    '.hybridclaw-runtime',
    'sessions',
    sessionStateKey(sessionId),
    name,
  );
}

export function turnCheckpointPath(
  workspaceRoot: string,
  sessionId: string,
): string {
  return sessionStatePath(workspaceRoot, sessionId, 'turn-checkpoint.json');
}

export function readTurnCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  maxBytes = Infinity,
): TurnCheckpointData | null {
  const file = turnCheckpointPath(workspaceRoot, sessionId);
  let raw: string;
  try {
    if (
      fs.realpathSync(file) !==
      path.join(
        fs.realpathSync(workspaceRoot),
        path.relative(workspaceRoot, file),
      )
    )
      throw new Error('Linked turn checkpoint refused.');
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile())
        throw new Error('Turn checkpoint must be a regular file.');
      if (stat.size > maxBytes)
        throw new Error('Turn checkpoint exceeds recovery limit.');
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const data: TurnCheckpointData = JSON.parse(raw);
  checkpointOutput(data);
  return data;
}

function callKey(messageIndex: number, id: string): string {
  return JSON.stringify([messageIndex, id]);
}

export function checkpointOutput(
  data: TurnCheckpointData,
): TurnRecoveryEvidence {
  if (
    data?.version !== 1 ||
    typeof data.turnId !== 'string' ||
    !data.turnId ||
    !Array.isArray(data.messages) ||
    !Array.isArray(data.started) ||
    data.started.some((id) => typeof id !== 'string') ||
    (data.assistantText !== undefined && typeof data.assistantText !== 'string')
  )
    throw new Error('Invalid turn checkpoint; automatic replay refused.');
  const messages: HistoryMessage[] = [];
  const executions: TurnRecoveryEvidence['toolExecutions'] = [];
  const calls: TurnRecoveryEvidence['recovery']['calls'] = [];
  const starts = new Set(data.started);
  const knownCalls = new Set<string>();
  for (let index = 0; index < data.messages.length; ) {
    const messageIndex = index;
    const message = data.messages[index++];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls))
      throw new Error('Invalid checkpoint exchange.');
    const results = new Map<string | undefined, HistoryMessage>();
    while (data.messages[index]?.role === 'tool') {
      const result = data.messages[index++];
      if (
        results.has(result.tool_call_id) ||
        !message.tool_calls.some((call) => call.id === result.tool_call_id)
      )
        throw new Error('Checkpoint outcome does not match its calls.');
      results.set(result.tool_call_id, result);
    }
    messages.push(message);
    for (const call of message.tool_calls) {
      const result = results.get(call.id);
      const key = callKey(messageIndex, call.id);
      knownCalls.add(key);
      const started = starts.has(key);
      if (!result && index < data.messages.length)
        throw new Error('Checkpoint contains an unfinished earlier exchange.');
      calls.push({
        messageIndex,
        toolCallId: call.id,
        outcome: result
          ? 'result_recorded'
          : started
            ? 'outcome_unknown'
            : 'not_executed',
      });
      const outcome: HistoryMessage = result || {
        role: 'tool',
        tool_call_id: call.id,
        is_error: true,
        content: started
          ? 'Tool outcome unknown: the worker stopped after execution started. Side effects may have occurred. Verify the external state before retrying; do not automatically repeat this action.'
          : 'Tool not executed: the worker stopped before execution started.',
      };
      messages.push(outcome);
      if (result || started)
        executions.push({
          name: call.function.name,
          arguments: call.function.arguments,
          toolCallId: call.id,
          result: outcome.content as string,
          isError: outcome.is_error === true,
          durationMs: 0,
        });
    }
  }
  if (
    starts.size !== data.started.length ||
    [...starts].some((key) => !knownCalls.has(key))
  )
    throw new Error('Checkpoint start does not match its calls.');
  const history = validateToolHistory(messages);
  return {
    status: 'error',
    result: null,
    recovery: { kind: 'recovered', turnId: data.turnId, calls },
    error:
      'The previous turn was interrupted. Completed tool outcomes were recovered. Any unknown side effects must be verified before retrying; actions were not automatically repeated.' +
      (data.assistantText
        ? `\n\nLast assistant checkpoint:\n${data.assistantText}`
        : ''),
    toolsUsed: [...new Set(executions.map((entry) => entry.name))],
    toolExecutions: executions,
    toolHistory: history,
    toolHistoryForReplay: history,
    ...(data.tokenUsage === undefined
      ? {}
      : { tokenUsage: validateTokenUsage(data.tokenUsage) }),
  };
}

/** A failed read or run mismatch is terminal evidence, never retry permission. */
export function readTurnRecovery(
  workspaceRoot: string,
  sessionId: string,
  turnId: string,
  maxBytes?: number,
): TurnRecoveryResult {
  try {
    const saved = readTurnCheckpoint(workspaceRoot, sessionId, maxBytes);
    if (!saved) return { kind: 'refused', reason: 'missing' };
    if (saved.turnId !== turnId)
      return { kind: 'refused', reason: 'run_mismatch' };
    return { kind: 'recovered', evidence: checkpointOutput(saved) };
  } catch {
    return { kind: 'refused', reason: 'unreadable' };
  }
}

export class TurnCheckpoint {
  declare private file: string;
  declare readonly recovered: ReturnType<typeof checkpointOutput> | null;
  declare private data: TurnCheckpointData;

  constructor(workspaceRoot: string, sessionId: string, turnId: string) {
    this.file = turnCheckpointPath(workspaceRoot, sessionId);
    const previous = readTurnCheckpoint(workspaceRoot, sessionId);
    // Routing may try another provider before any tool was proposed.
    this.recovered =
      previous?.turnId === turnId && previous.messages.length
        ? checkpointOutput(previous)
        : null;
    this.data = { version: 1, turnId, messages: [], started: [] };
    if (!this.recovered) this.persist();
  }

  usage(stats: TokenUsageStats): void {
    this.persist({ ...this.data, tokenUsage: validateTokenUsage(stats) });
  }

  snapshot(): TurnRecoveryEvidence {
    return structuredClone(this.recovered ?? checkpointOutput(this.data));
  }

  assistant(message: CheckpointMessage): void {
    if (message?.role !== 'assistant')
      throw new Error('Invalid checkpoint assistant message.');
    const next = structuredClone(this.data);
    if (typeof message.content === 'string' && message.content) {
      next.assistantText = message.content;
    }
    if (message.tool_calls?.length)
      next.messages.push(structuredClone(message) as HistoryMessage);
    this.persist(next);
  }

  start(id: string): void {
    const next = structuredClone(this.data);
    const index = (next.messages as FindLastIndexArray).findLastIndex(
      (entry) => entry.role === 'assistant',
    );
    const key = callKey(index, id);
    if (
      next.started.includes(key) ||
      next.messages.slice(index + 1).some((entry) => entry.tool_call_id === id)
    )
      throw new Error(
        'Checkpoint call has already started or recorded a result.',
      );
    next.started.push(key);
    this.persist(next); // A failed write prevents the action from starting.
  }

  result(message: CheckpointMessage): void {
    if (message?.role !== 'tool')
      throw new Error('Invalid checkpoint result message.');
    const next = structuredClone(this.data);
    const assistantIndex = (next.messages as FindLastIndexArray).findLastIndex(
      (entry) => entry.role === 'assistant',
    );
    const previous = next.messages.find(
      (entry, index) =>
        index > assistantIndex &&
        entry.role === 'tool' &&
        entry.tool_call_id === message.tool_call_id,
    );
    // Batch assembly records the same completion after checkpointExecution.
    // It may acknowledge that result, but must never replace durable evidence.
    if (previous) {
      if (
        !isDeepStrictEqual(
          JSON.parse(JSON.stringify(previous)),
          JSON.parse(JSON.stringify(message)),
        )
      )
        throw new Error(
          'Checkpoint result conflicts with its recorded outcome.',
        );
    } else next.messages.push(structuredClone(message) as HistoryMessage);
    this.persist(next);
  }

  private persist(next: TurnCheckpointData = this.data): void {
    if (this.recovered)
      throw new Error(
        'Recovered checkpoint is evidence only; execution refused.',
      );
    checkpointOutput(next);
    writeFileAtomic(this.file, JSON.stringify(next), {
      mode: 0o600,
      dirMode: 0o700,
    });
    this.data = next;
  }
}
