/**
 * SandboxServiceBackend — implements ContainerBackend using sandbox-service HTTP API.
 *
 * Activated via: HYBRIDCLAW_BACKEND=sandbox-service
 * Required env vars:
 *   HYBRIDCLAW_SANDBOX_URL   — base URL of the sandbox-service (e.g. http://localhost:8080)
 *   HYBRIDCLAW_SANDBOX_TOKEN — Bearer token for authentication (optional)
 */
import readline from 'readline';

import { logger } from '../logger.js';
import type { ChatMessage, ContainerInput, ContainerOutput, ScheduledTask, ToolProgressEvent } from '../types.js';
import {
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MODEL,
  getHybridAIApiKey,
} from '../config.js';
import type { ContainerBackend, RunContainerOptions } from './types.js';

const SANDBOX_URL = (process.env.HYBRIDCLAW_SANDBOX_URL || '').replace(/\/+$/, '');
const SANDBOX_TOKEN = process.env.HYBRIDCLAW_SANDBOX_TOKEN || '';

function authHeaders(): Record<string, string> {
  if (SANDBOX_TOKEN) return { Authorization: `Bearer ${SANDBOX_TOKEN}` };
  return {};
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${SANDBOX_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sandbox-service ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export class SandboxServiceBackend implements ContainerBackend {
  private sandboxIds = new Map<string, string>(); // sessionId → sandboxId

  getActiveCount(): number {
    return this.sandboxIds.size;
  }

  stop(sandboxId: string): void {
    void apiRequest('DELETE', `/v1/sandboxes/${sandboxId}`).catch((err) => {
      logger.debug({ sandboxId, err }, 'Failed to delete sandbox');
    });
  }

  stopAll(): void {
    for (const [sessionId, sandboxId] of this.sandboxIds) {
      logger.info({ sessionId, sandboxId }, 'Deleting sandbox (shutdown)');
      this.stop(sandboxId);
    }
    this.sandboxIds.clear();
  }

  private async getOrCreateSandbox(sessionId: string): Promise<string> {
    const existing = this.sandboxIds.get(sessionId);
    if (existing) return existing;

    const res = await apiRequest('POST', '/v1/sandboxes', {}) as { sandbox_id: string };
    const sandboxId = res.sandbox_id;
    this.sandboxIds.set(sessionId, sandboxId);
    logger.info({ sessionId, sandboxId }, 'Created sandbox');
    return sandboxId;
  }

  async run(
    sessionId: string,
    messages: ChatMessage[],
    options: RunContainerOptions,
  ): Promise<ContainerOutput> {
    const {
      chatbotId,
      enableRag,
      model = HYBRIDAI_MODEL,
      channelId = '',
      scheduledTasks,
      allowedTools,
      onToolProgress,
      abortSignal,
    } = options;

    let sandboxId: string;
    try {
      sandboxId = await this.getOrCreateSandbox(sessionId);
    } catch (err) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const input: ContainerInput = {
      sessionId,
      messages,
      chatbotId,
      enableRag,
      apiKey: getHybridAIApiKey(),
      baseUrl: HYBRIDAI_BASE_URL,
      model,
      channelId,
      scheduledTasks: scheduledTasks?.map((t) => ({
        id: t.id,
        cronExpr: t.cron_expr,
        runAt: t.run_at,
        everyMs: t.every_ms,
        prompt: t.prompt,
        enabled: t.enabled,
        lastRun: t.last_run,
        createdAt: t.created_at,
      })),
      allowedTools,
    };

    try {
      const streamRes = await fetch(`${SANDBOX_URL}/v1/sandboxes/${sandboxId}/process/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          command: ['node', '/app/dist/index.js'],
          env: { HYBRIDCLAW_INPUT: JSON.stringify(input) },
          stdin: JSON.stringify(input) + '\n',
        }),
        signal: abortSignal,
      });

      if (!streamRes.ok) {
        const text = await streamRes.text().catch(() => '');
        this.sandboxIds.delete(sessionId);
        return {
          status: 'error',
          result: null,
          toolsUsed: [],
          error: `Sandbox process stream failed: ${streamRes.status} ${text}`,
        };
      }

      return await this.readStreamResponse(streamRes, onToolProgress, sessionId);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        return { status: 'error', result: null, toolsUsed: [], error: 'Interrupted by user.' };
      }
      this.sandboxIds.delete(sessionId);
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Sandbox run error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async readStreamResponse(
    res: Response,
    onToolProgress: ((event: ToolProgressEvent) => void) | undefined,
    sessionId: string,
  ): Promise<ContainerOutput> {
    const reader = res.body?.getReader();
    if (!reader) {
      return { status: 'error', result: null, toolsUsed: [], error: 'No response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // SSE data: prefix or other formats
          const dataLine = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
          try {
            event = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            continue;
          }
        }

        if (event.type === 'tool_start' || event.type === 'tool_finish') {
          if (onToolProgress) {
            try {
              onToolProgress({
                sessionId,
                toolName: String(event.name || ''),
                phase: event.type === 'tool_start' ? 'start' : 'finish',
                durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
                preview: typeof event.preview === 'string' ? event.preview : undefined,
              });
            } catch (err) {
              logger.debug({ sessionId, err }, 'Tool progress callback failed');
            }
          }
          continue;
        }

        if (event.type === 'result' || (event.text !== undefined)) {
          // Final result event
          return {
            status: (event.status as ContainerOutput['status']) || 'success',
            result: typeof event.result === 'string' ? event.result : (typeof event.text === 'string' ? event.text : null),
            toolsUsed: Array.isArray(event.toolsUsed) ? (event.toolsUsed as string[]) : [],
            error: typeof event.error === 'string' ? event.error : undefined,
          };
        }
      }
    }

    return { status: 'error', result: null, toolsUsed: [], error: 'Stream ended without result' };
  }
}
