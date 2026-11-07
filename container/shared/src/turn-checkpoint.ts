/**
 * Durable turn evidence, shared by worker and gateway. A started call without
 * a result is uncertain and is never replayed here. Unlike IPC replies this
 * journal survives worker replacement; it grants no authority to execute tools.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import type { HistoryMessage } from './tool-history.js';
import { validateToolHistory } from './tool-history.js';

type CheckpointMessage = Omit<HistoryMessage, 'content'> & { content: unknown };

export interface TurnCheckpointData {
  version: 1;
  turnId: string;
  messages: HistoryMessage[];
  started: string[];
  assistantText?: string;
}

export interface TurnCheckpointOutput {
  status: 'error';
  result: null;
  error: string;
  toolsUsed: string[];
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
  const data = JSON.parse(raw);
  if (
    data.version !== 1 ||
    typeof data.turnId !== 'string' ||
    !Array.isArray(data.messages) ||
    !Array.isArray(data.started) ||
    data.started.some((id: unknown) => typeof id !== 'string') ||
    (data.assistantText !== undefined && typeof data.assistantText !== 'string')
  ) {
    throw new Error('Invalid turn checkpoint; automatic replay refused.');
  }
  // Validate even unfinished exchanges by closing them conservatively.
  checkpointOutput(data);
  return data as TurnCheckpointData;
}

function callKey(messageIndex: number, id: string): string {
  return JSON.stringify([messageIndex, id]);
}

export function checkpointOutput(
  data: TurnCheckpointData,
): TurnCheckpointOutput {
  const messages: HistoryMessage[] = [];
  const executions: TurnCheckpointOutput['toolExecutions'] = [];
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
    for (const call of message.tool_calls || []) {
      const result = results.get(call.id);
      const key = callKey(messageIndex, call.id);
      knownCalls.add(key);
      const started = starts.has(key);
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
          result: outcome.content ?? '',
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
    error:
      'The previous turn was interrupted. Completed tool outcomes were recovered. Any unknown side effects must be verified before retrying; actions were not automatically repeated.' +
      (data.assistantText
        ? `\n\nLast assistant checkpoint:\n${data.assistantText}`
        : ''),
    toolsUsed: [...new Set(executions.map((entry) => entry.name))],
    toolExecutions: executions,
    toolHistory: history,
    toolHistoryForReplay: history,
  };
}

export class TurnCheckpoint {
  private readonly file: string;
  private readonly data: TurnCheckpointData;
  readonly recovered: TurnCheckpointOutput | null;

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

  assistant(message: CheckpointMessage): void {
    if (typeof message.content === 'string' && message.content) {
      this.data.assistantText = message.content;
    }
    if (message.tool_calls?.length)
      this.data.messages.push(structuredClone(message) as HistoryMessage);
    this.persist();
  }

  start(id: string): void {
    const index = this.data.messages.findLastIndex(
      (entry) => entry.role === 'assistant',
    );
    this.data.started.push(callKey(index, id));
    this.persist(); // A failed write prevents the action from starting.
  }

  result(message: CheckpointMessage): void {
    const assistantIndex = this.data.messages.findLastIndex(
      (entry) => entry.role === 'assistant',
    );
    const index = this.data.messages.findIndex(
      (entry, index) =>
        index > assistantIndex &&
        entry.role === 'tool' &&
        entry.tool_call_id === message.tool_call_id,
    );
    const copy = structuredClone(message) as HistoryMessage;
    if (index < 0) this.data.messages.push(copy);
    else this.data.messages[index] = copy;
    this.persist();
  }

  private persist(): void {
    checkpointOutput(this.data);
    writeFileAtomic(this.file, JSON.stringify(this.data), {
      mode: 0o600,
      dirMode: 0o700,
    });
  }
}
