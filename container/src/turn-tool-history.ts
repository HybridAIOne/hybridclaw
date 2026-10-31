/**
 * Captures this turn's tool exchanges before context pruning can erase them.
 * Unlike loop detection, it retains ordered model messages for later replay;
 * unexecuted calls receive explicit terminal results, never fabricated success,
 * and calls a signal cut off are marked "outcome unknown", never "not run".
 * Models and replay see bounded excerpts with durable file references; the
 * gateway restores full evidence only for audit and transcript storage.
 * Call starts and individual results are checkpointed before batch assembly,
 * so an abrupt worker kill cannot erase completed outcomes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shared/atomic-write.js';
import {
  toolResultFilePath,
  toolResultForTransport,
  validateToolHistory,
} from '../shared/tool-history.js';
import { TurnCheckpoint } from '../shared/turn-checkpoint.js';
import type { ChatMessage, ContainerOutput } from './types.js';

// Engineering choice, 2026-10-30: cap inline evidence at 16k characters;
// retain full text on disk rather than rely on a larger compression model.
const TOOL_RESULT_SPILL_THRESHOLD_CHARS = 16_000;
const TOOL_RESULT_EXCERPT_CHARS = 8_000;

export class TurnToolHistory {
  private readonly messages: ChatMessage[] = [];
  private readonly replayMessages: ChatMessage[] = [];
  /** Full text and its IPC reference for results saved to a file. */
  private readonly savedResults = new Map<
    string,
    { full: string; reference: string }
  >();
  private activeHistory: ChatMessage[] | undefined;
  private readonly checkpoint?: TurnCheckpoint;
  readonly recovered: ContainerOutput | null;

  constructor(
    private readonly sessionId: string,
    private readonly workspaceRoot?: string,
    private readonly executionRoot = workspaceRoot,
    turnId?: string,
  ) {
    if (workspaceRoot && turnId)
      this.checkpoint = new TurnCheckpoint(workspaceRoot, sessionId, turnId);
    this.recovered = this.checkpoint?.recovered ?? null;
  }

  retain(history: ChatMessage[]): void {
    this.activeHistory = history;
  }

  recordAssistant(message: ChatMessage): void {
    this.checkpoint?.assistant(message);
    if (message.tool_calls?.length) {
      this.messages.push(structuredClone(message));
      this.replayMessages.push(message);
    }
  }

  recordResult(message: ChatMessage): ChatMessage {
    const visible = this.forContext(message);
    this.checkpoint?.result(visible);
    this.messages.push(structuredClone(message));
    this.replayMessages.push(visible);
    return visible;
  }

  /** Recover old oversized results, including a protected newest exchange. */
  boundContext(history: ChatMessage[], contextWindow = 128_000): boolean {
    // Engineering choice, 2026-10-30: reserve most of the window for the
    // request and schemas when ordinary compaction cannot make progress.
    const maxChars = Math.max(
      256,
      Math.min(TOOL_RESULT_EXCERPT_CHARS, Math.floor(contextWindow / 8)),
    );
    let changed = false;
    for (let index = 0; index < history.length; index += 1) {
      const message = history[index];
      if (
        message.role !== 'tool' ||
        typeof message.content !== 'string' ||
        message.content.length <= maxChars * 2
      )
        continue;
      const visible = this.forContext(message, maxChars, maxChars * 2, true);
      if (
        visible !== message &&
        String(visible.content).length < message.content.length
      ) {
        history[index] = visible;
        const replayIndex = this.replayMessages.indexOf(message);
        if (replayIndex !== -1) this.replayMessages[replayIndex] = visible;
        changed = true;
      }
    }
    return changed;
  }

  private contextPath(relative: string): string {
    return this.workspaceRoot && this.workspaceRoot !== this.executionRoot
      ? path.join(this.workspaceRoot, relative)
      : relative;
  }

  private forContext(
    message: ChatMessage,
    excerptChars = TOOL_RESULT_EXCERPT_CHARS,
    threshold = TOOL_RESULT_SPILL_THRESHOLD_CHARS,
    recovering = false,
  ): ChatMessage {
    const existingReference = String(
      toolResultForTransport(
        message,
        this.contextPath(
          toolResultFilePath(this.sessionId, message.tool_call_id),
        ),
      ).content,
    );
    if (
      recovering &&
      message.role === 'tool' &&
      typeof message.content === 'string' &&
      message.content.startsWith(existingReference)
    ) {
      return {
        ...message,
        content: `${existingReference}\n[Excerpt shortened for context recovery; use read with char_offset/max_chars or query.]\n${message.content.slice(-excerptChars)}`,
      };
    }
    const savedPath = this.saveFullResult(message, threshold);
    if (
      !savedPath ||
      !message.tool_call_id ||
      typeof message.content !== 'string'
    )
      return message;
    const contextPath = this.contextPath(savedPath);
    const reference = String(
      toolResultForTransport(message, contextPath).content,
    );
    this.savedResults.set(message.tool_call_id, {
      full: message.content,
      reference: String(toolResultForTransport(message, savedPath).content),
    });
    const headChars = Math.floor(excerptChars * 0.75);
    return {
      ...message,
      content: `${reference}\n${message.content.length} characters total. Excerpt only; use read with path=${JSON.stringify(contextPath)}, char_offset/max_chars for slices or query for literal search.\n\n${message.content.slice(0, headChars)}\n\n[... omitted ...]\n\n${message.content.slice(-(excerptChars - headChars))}`,
    };
  }

  async checkpointExecution<
    T extends {
      output: string;
      isError: boolean;
      visualAttachments?: ChatMessage['visualAttachments'];
    },
  >(id: string, execute: () => Promise<T>): Promise<T> {
    this.checkpoint?.start(id);
    const result = await execute();
    this.checkpoint?.result(
      this.forContext({
        role: 'tool',
        tool_call_id: id,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
        ...(result.visualAttachments
          ? { visualAttachments: result.visualAttachments }
          : {}),
      }),
    );
    return result;
  }

  /** Send file references across IPC; leave context compaction edits intact. */
  withSpilledReferences(output: ContainerOutput): ContainerOutput {
    if (!this.savedResults.size) return output;
    const transportHistory = (history: ChatMessage[] | undefined) =>
      history?.map((message) => {
        const saved =
          message.role === 'tool' && message.tool_call_id
            ? this.savedResults.get(message.tool_call_id)
            : undefined;
        return saved && message.content === saved.full
          ? { ...message, content: saved.reference }
          : message;
      });
    return {
      ...output,
      ...(output.toolHistory
        ? { toolHistory: transportHistory(output.toolHistory) }
        : {}),
      ...(output.toolHistoryForReplay
        ? {
            toolHistoryForReplay: transportHistory(output.toolHistoryForReplay),
          }
        : {}),
      ...(output.toolExecutions
        ? {
            toolExecutions: output.toolExecutions.map((execution) => {
              const reference =
                execution.toolCallId &&
                this.savedResults.get(execution.toolCallId)?.reference;
              return reference
                ? { ...execution, result: reference }
                : execution;
            }),
          }
        : {}),
      spilledToolCallIds: [...this.savedResults.keys()],
    };
  }

  private saveFullResult(
    message: ChatMessage,
    threshold: number,
  ): string | undefined {
    if (
      message.role !== 'tool' ||
      !this.workspaceRoot ||
      typeof message.content !== 'string' ||
      message.content.length <= threshold
    )
      return undefined;
    const relative = toolResultFilePath(this.sessionId, message.tool_call_id);
    try {
      const filePath = path.join(this.workspaceRoot, relative);
      const root = fs.realpathSync(this.workspaceRoot);
      let dir = root;
      for (const component of path.dirname(relative).split('/')) {
        dir = path.join(dir, component);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.realpathSync(dir) !== dir) return undefined;
      }
      if (fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink())
        return undefined;
      writeFileAtomic(filePath, message.content, { mode: 0o600 });
      return relative;
    } catch {
      return undefined;
    }
  }

  finish(reason: string, forReplay = false): ChatMessage[] {
    return this.close(`Tool not executed: ${reason}`, forReplay);
  }

  /**
   * For a turn killed mid-flight: an open call may already be running, so its
   * outcome is unknown rather than "not executed".
   */
  finishInterrupted(reason: string, forReplay = false): ChatMessage[] {
    return this.close(`Tool outcome unknown: ${reason}`, forReplay);
  }

  private close(openCallResult: string, forReplay: boolean): ChatMessage[] {
    const completed = structuredClone(
      forReplay
        ? this.replayMessages.filter(
            (message) =>
              !this.activeHistory || this.activeHistory.includes(message),
          )
        : this.messages,
    );
    const pending = new Set<string>();
    for (const message of completed) {
      for (const call of message.tool_calls || []) pending.add(call.id);
      if (message.role === 'tool' && message.tool_call_id)
        pending.delete(message.tool_call_id);
    }
    for (const id of pending) {
      completed.push({
        role: 'tool',
        tool_call_id: id,
        content: openCallResult,
        is_error: true,
      });
    }
    // Fail the turn on a pairing bug: persisting it would corrupt future replay,
    // and silently dropping history could hide tool side effects.
    return validateToolHistory(completed);
  }
}
