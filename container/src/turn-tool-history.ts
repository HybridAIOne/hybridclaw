/**
 * Captures this turn's tool exchanges before context pruning can erase them.
 * Unlike loop detection, it retains ordered model messages for later replay;
 * unexecuted calls receive explicit terminal results, never fabricated success,
 * and calls a signal cut off are marked "outcome unknown", never "not run".
 * Models and replay see bounded excerpts with durable file references; the
 * gateway restores full evidence only for audit and transcript storage.
 * Call starts and individual results are checkpointed before batch assembly,
 * including file-backed result IDs, so recovery can restore full evidence
 * without expanding model replay after a worker kill.
 * Saved results bind their content digest, not a reusable provider call ID.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@hybridclaw/shared/atomic-write';
import { validateTokenUsage } from '@hybridclaw/shared/token-usage';
import {
  toolResultDigest,
  toolResultFilePath,
  toolResultForTransport,
  validateToolHistory,
} from '@hybridclaw/shared/tool-history';
import { TurnCheckpoint } from '@hybridclaw/shared/turn-checkpoint';
import { createTokenUsageStats, finalizeTokenUsage } from './token-usage.js';
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
    { full: string; reference: string; resultDigest: string }
  >();
  private activeHistory: ChatMessage[] | undefined;
  private readonly checkpoint?: TurnCheckpoint;
  readonly recovered: ContainerOutput | null;
  readonly tokenUsage = createTokenUsageStats();

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

  checkpointUsage(): void {
    this.checkpoint?.usage(finalizeTokenUsage(this.tokenUsage));
  }

  interruptedOutput(reason: string): ContainerOutput {
    const saved = this.checkpoint?.snapshot();
    const recovered = this.recovered ? saved : undefined;
    const history = recovered?.toolHistory ?? this.finishInterrupted(reason);
    return this.withSpilledReferences({
      status: 'error',
      result: null,
      toolsUsed: saved?.toolsUsed ?? [],
      toolExecutions: saved?.toolExecutions ?? [],
      tokenUsage:
        recovered?.tokenUsage ??
        validateTokenUsage(finalizeTokenUsage(this.tokenUsage)),
      ...(history.length
        ? {
            toolHistory: history,
            toolHistoryForReplay:
              recovered?.toolHistoryForReplay ??
              this.finishInterrupted(reason, true),
          }
        : {}),
    });
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
    this.messages.push({
      ...structuredClone(message),
      ...(visible.resultDigest ? { resultDigest: visible.resultDigest } : {}),
    });
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
    const existingReference = message.resultDigest
      ? String(
          toolResultForTransport(
            message,
            this.contextPath(
              toolResultFilePath(
                this.sessionId,
                message.tool_call_id,
                message.resultDigest,
              ),
            ),
          ).content,
        )
      : undefined;
    if (
      recovering &&
      existingReference !== undefined &&
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
    const contextPath = this.contextPath(savedPath.relative);
    const reference = String(
      toolResultForTransport(message, contextPath).content,
    );
    this.savedResults.set(savedPath.relative, {
      full: message.content,
      reference: String(
        toolResultForTransport(message, savedPath.relative).content,
      ),
      resultDigest: savedPath.resultDigest,
    });
    const headChars = Math.floor(excerptChars * 0.75);
    return {
      ...message,
      resultDigest: savedPath.resultDigest,
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
    const spilledIds = new Set(output.spilledToolCallIds || []);
    const savedResult = (
      id: string | undefined,
      content: ChatMessage['content'],
      digest?: string,
    ) => {
      if (!id || typeof content !== 'string') return undefined;
      const saved = this.savedResults.get(
        toolResultFilePath(
          this.sessionId,
          id,
          digest ?? toolResultDigest(content),
        ),
      );
      if (saved) spilledIds.add(id);
      return saved;
    };
    const transportHistory = (history: ChatMessage[] | undefined) =>
      history?.map((message) => {
        const saved =
          message.role === 'tool'
            ? savedResult(
                message.tool_call_id,
                message.content,
                message.resultDigest,
              )
            : undefined;
        return saved && message.content === saved.full
          ? {
              ...message,
              content: saved.reference,
              resultDigest: saved.resultDigest,
            }
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
              const saved = savedResult(
                execution.toolCallId,
                execution.result,
                execution.resultDigest,
              );
              return saved && execution.result === saved.full
                ? {
                    ...execution,
                    result: saved.reference,
                    resultDigest: saved.resultDigest,
                  }
                : execution;
            }),
          }
        : {}),
      spilledToolCallIds: [...spilledIds],
    };
  }

  private saveFullResult(
    message: ChatMessage,
    threshold: number,
  ): { relative: string; resultDigest: string } | undefined {
    if (
      message.role !== 'tool' ||
      !message.tool_call_id ||
      !this.workspaceRoot ||
      typeof message.content !== 'string' ||
      message.content.length <= threshold
    )
      return undefined;
    const resultDigest = toolResultDigest(message.content);
    const relative = toolResultFilePath(
      this.sessionId,
      message.tool_call_id,
      resultDigest,
    );
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
      return { relative, resultDigest };
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
    const saved = this.checkpoint?.snapshot().toolHistory ?? [];
    let lastAssistant = saved.length - 1;
    while (lastAssistant >= 0 && saved[lastAssistant].role !== 'assistant')
      lastAssistant--;
    const outcomes = new Map(
      saved
        .slice(lastAssistant + 1)
        .map((message) => [message.tool_call_id, message]),
    );
    return this.close(`Tool outcome unknown: ${reason}`, forReplay, outcomes);
  }

  private close(
    openCallResult: string,
    forReplay: boolean,
    outcomes?: Map<string | undefined, ChatMessage>,
  ): ChatMessage[] {
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
      completed.push(
        outcomes?.get(id) ?? {
          role: 'tool',
          tool_call_id: id,
          content: openCallResult,
          is_error: true,
        },
      );
    }
    // Fail the turn on a pairing bug: persisting it would corrupt future replay,
    // and silently dropping history could hide tool side effects.
    return validateToolHistory(completed);
  }
}
