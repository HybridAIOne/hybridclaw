/**
 * File-backed IPC restores complete results for audit and storage.
 * Bounded model excerpts stay bounded during replay.
 * Unlike context compaction, this decodes references without changing evidence.
 * Worker-controlled paths must be derived and link-free; restoration retains
 * explicit references on read failure, digest mismatch or transport-budget overflow.
 * Each message binds its own saved bytes; reusable provider IDs are only a manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  isToolResultDigest,
  toolResultDigest,
  toolResultFilePath,
  toolResultForTransport,
} from '@hybridclaw/shared/tool-history';
import { CONTAINER_MAX_OUTPUT_SIZE } from '../config/config.js';
import { logger } from '../logger.js';
import type { ContainerOutput } from '../types/container.js';

export function restoreSpilledToolResults(
  output: ContainerOutput,
  params: { sessionId: string; workspaceRoot: string },
): ContainerOutput {
  const ids = new Set(output.spilledToolCallIds || []);
  if (!ids.size) return output;
  const restored = new Map<string, string | null>();
  let remainingBytes = CONTAINER_MAX_OUTPUT_SIZE;
  const lookup = (
    id: string | undefined,
    digest: string | undefined,
  ): string | undefined => {
    if (!id || !ids.has(id) || !isToolResultDigest(digest)) return undefined;
    const relative = toolResultFilePath(params.sessionId, id, digest);
    if (!restored.has(relative)) {
      const saved = readSavedResult(
        params.workspaceRoot,
        relative,
        remainingBytes,
        digest,
      );
      restored.set(relative, saved?.text ?? null);
      if (saved) remainingBytes -= saved.bytes;
    }
    return restored.get(relative) ?? undefined;
  };
  const history = (
    messages: ContainerOutput['toolHistory'],
    referenceOnly = false,
  ) =>
    messages?.map((message) => {
      if (message.role !== 'tool' || !isToolResultDigest(message.resultDigest))
        return message;
      const text = lookup(message.tool_call_id, message.resultDigest);
      if (text === undefined) return message;
      const reference = toolResultForTransport(
        message,
        toolResultFilePath(
          params.sessionId,
          message.tool_call_id,
          message.resultDigest,
        ),
      ).content;
      return !referenceOnly || message.content === reference
        ? { ...message, content: text }
        : message;
    });
  const result = {
    ...output,
    ...(output.toolHistory ? { toolHistory: history(output.toolHistory) } : {}),
    ...(output.toolExecutions
      ? {
          toolExecutions: output.toolExecutions.map((execution) => {
            const text = lookup(execution.toolCallId, execution.resultDigest);
            return text === undefined
              ? execution
              : { ...execution, result: text };
          }),
        }
      : {}),
    ...(output.toolHistoryForReplay
      ? { toolHistoryForReplay: history(output.toolHistoryForReplay, true) }
      : {}),
  };
  const failed = [...restored.values()].filter(
    (value) => value === null,
  ).length;
  if (failed)
    logger.warn(
      {
        sessionId: params.sessionId,
        spilled: restored.size,
        restored: restored.size - failed,
        limit: CONTAINER_MAX_OUTPUT_SIZE,
      },
      'Kept tool result references: saved result unreadable, changed or over the output limit',
    );
  return result;
}

function readSavedResult(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
  digest: string,
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
    const text = buffer.toString('utf8', 0, bytes);
    return toolResultDigest(text) === digest ? { text, bytes } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
