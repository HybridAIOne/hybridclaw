/**
 * Captures this turn's tool exchanges before context pruning can erase them.
 * Unlike loop detection, it retains ordered model messages for later replay;
 * unexecuted calls receive explicit terminal results, never fabricated success,
 * and calls a signal cut off are marked "outcome unknown", never "not run".
 * Models see complete results. Large text crosses IPC as a file reference,
 * restored by the gateway for storage and replay without a per-result cap.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  TOOL_RESULTS_DIR,
  toolResultFilePath,
  toolResultForTransport,
  validateToolHistory,
} from '../shared/tool-history.js';
import type { ChatMessage, ContainerOutput } from './types.js';

// Engineering choice, 2026-10-03: spill above 16k for IPC, never model context.
const TOOL_RESULT_SPILL_THRESHOLD_CHARS = 16_000;
const TOOL_RESULT_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class TurnToolHistory {
  private readonly messages: ChatMessage[] = [];
  private readonly replayMessages: ChatMessage[] = [];
  /** Full text and its IPC reference for results saved to a file. */
  private readonly savedResults = new Map<
    string,
    { full: string; reference: string }
  >();
  private activeHistory: ChatMessage[] | undefined;
  private prunedStaleResults = false;

  constructor(
    private readonly sessionId: string,
    private readonly workspaceRoot?: string,
  ) {}

  retain(history: ChatMessage[]): void {
    this.activeHistory = history;
  }

  recordAssistant(message: ChatMessage): void {
    if (message.tool_calls?.length) {
      this.messages.push(structuredClone(message));
      this.replayMessages.push(message);
    }
  }

  recordResult(message: ChatMessage): ChatMessage {
    const savedPath = this.saveFullResult(message);
    const visible = toolResultForTransport(message, savedPath);
    if (savedPath && message.tool_call_id) {
      this.savedResults.set(message.tool_call_id, {
        full: String(message.content),
        reference: String(visible.content),
      });
    }
    this.messages.push(structuredClone(message));
    this.replayMessages.push(message);
    return message;
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

  private saveFullResult(message: ChatMessage): string | undefined {
    if (
      !this.workspaceRoot ||
      typeof message.content !== 'string' ||
      message.content.length <= TOOL_RESULT_SPILL_THRESHOLD_CHARS
    )
      return undefined;
    const relative = toolResultFilePath(this.sessionId, message.tool_call_id);
    try {
      const filePath = path.join(this.workspaceRoot, relative);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, message.content, { mode: 0o600 });
      this.pruneStaleResults();
      return relative;
    } catch {
      return undefined;
    }
  }

  private pruneStaleResults(): void {
    if (this.prunedStaleResults || !this.workspaceRoot) return;
    this.prunedStaleResults = true;
    const root = path.join(this.workspaceRoot, TOOL_RESULTS_DIR);
    const cutoff = Date.now() - TOOL_RESULT_FILE_MAX_AGE_MS;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        if (fs.statSync(dir).mtimeMs < cutoff)
          fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
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
