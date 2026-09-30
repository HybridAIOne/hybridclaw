/**
 * Restores tool results a worker sent as previews. A result the worker saved
 * to `.tool-results/` crosses IPC once, as the preview the model saw; this
 * puts the full text back into `toolHistory` and `toolExecutions` for the
 * transcript, the audit trail and result parsers. `toolHistoryForReplay`
 * keeps the preview on purpose.
 *
 * The worker can write the workspace, so the path is derived from the session
 * and tool call id and must reach a regular file without links. Restored text
 * per turn is bounded by the worker output limit; past it, or on any read
 * failure, a result stays its preview (which names the saved file) instead of
 * failing the turn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toolResultFilePath } from '../../container/shared/tool-history.js';
import { CONTAINER_MAX_OUTPUT_SIZE } from '../config/config.js';
import { logger } from '../logger.js';
import type { ContainerOutput } from '../types/container.js';

export function restoreSpilledToolResults(
  output: ContainerOutput,
  params: { sessionId: string; workspaceRoot: string },
): ContainerOutput {
  const ids = output.spilledToolCallIds;
  if (!ids?.length) return output;
  const restored = new Map<string, string>();
  let remainingBytes = CONTAINER_MAX_OUTPUT_SIZE;
  for (const id of ids) {
    const saved = readSavedResult(
      params.workspaceRoot,
      toolResultFilePath(params.sessionId, id),
      remainingBytes,
    );
    if (!saved) continue;
    restored.set(id, saved.text);
    remainingBytes -= saved.bytes;
  }
  if (restored.size < ids.length) {
    logger.warn(
      {
        sessionId: params.sessionId,
        spilled: ids.length,
        restored: restored.size,
        limit: CONTAINER_MAX_OUTPUT_SIZE,
      },
      'Kept tool result previews: saved result unreadable or over the output limit',
    );
  }
  return {
    ...output,
    ...(output.toolHistory
      ? {
          toolHistory: output.toolHistory.map((message) => {
            const text =
              message.role === 'tool' && message.tool_call_id
                ? restored.get(message.tool_call_id)
                : undefined;
            return text === undefined ? message : { ...message, content: text };
          }),
        }
      : {}),
    ...(output.toolExecutions
      ? {
          toolExecutions: output.toolExecutions.map((execution) => {
            const text = execution.toolCallId
              ? restored.get(execution.toolCallId)
              : undefined;
            return text === undefined
              ? execution
              : { ...execution, result: text };
          }),
        }
      : {}),
  };
}

function readSavedResult(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
): { text: string; bytes: number } | null {
  let fd: number | undefined;
  try {
    const filePath = path.join(fs.realpathSync(workspaceRoot), relativePath);
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    // A directory swapped for a link while opening could have redirected the
    // open: the path must be link-free now and still name the opened file.
    const named = fs.lstatSync(filePath);
    if (
      fs.realpathSync(filePath) !== filePath ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      return null;
    }
    const buffer = Buffer.alloc(opened.size);
    const bytes = fs.readSync(fd, buffer, 0, opened.size, 0);
    return { text: buffer.toString('utf8', 0, bytes), bytes };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
