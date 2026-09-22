/**
 * Captures this turn's tool exchanges before context pruning can erase them.
 * Unlike loop detection, it retains ordered model messages for later replay;
 * unexecuted calls receive explicit terminal results, never fabricated success.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  TOOL_HISTORY_RESULT_MAX_CHARS,
  TOOL_RESULTS_DIR,
  toolResultFilePath,
  toolResultForHistory,
  validateToolHistory,
} from '../shared/tool-history.js';
import type { ChatMessage } from './types.js';

const TOOL_RESULT_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class TurnToolHistory {
  private readonly messages: ChatMessage[] = [];
  private readonly replayMessages: ChatMessage[] = [];
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
    this.messages.push(structuredClone(message));
    const visible = toolResultForHistory(
      message,
      this.sessionId,
      this.saveFullResult(message),
    );
    this.replayMessages.push(visible);
    return visible;
  }

  private saveFullResult(message: ChatMessage): string | undefined {
    if (
      !this.workspaceRoot ||
      typeof message.content !== 'string' ||
      message.content.length <= TOOL_HISTORY_RESULT_MAX_CHARS
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
        content: `Tool not executed: ${reason}`,
        is_error: true,
      });
    }
    // Fail the turn on a pairing bug: persisting it would corrupt future replay,
    // and silently dropping history could hide tool side effects.
    return validateToolHistory(completed);
  }
}
