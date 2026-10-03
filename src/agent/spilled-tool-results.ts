/**
 * File-backed IPC restores complete results for audit, storage and replay.
 * Unlike context compaction, this decodes references without changing evidence.
 * Worker-controlled paths must be derived and link-free; restoration retains
 * explicit references on read failure or aggregate transport-budget overflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  toolResultFilePath,
  toolResultForTransport,
} from '../../container/shared/tool-history.js';
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
      'Kept tool result references: saved result unreadable or over the output limit',
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
    ...(output.toolHistoryForReplay
      ? {
          toolHistoryForReplay: output.toolHistoryForReplay.map((message) => {
            const id = message.tool_call_id;
            const text =
              message.role === 'tool' && id ? restored.get(id) : undefined;
            const reference = id
              ? toolResultForTransport(
                  message,
                  toolResultFilePath(params.sessionId, id),
                ).content
              : undefined;
            return text !== undefined && message.content === reference
              ? { ...message, content: text }
              : message;
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
