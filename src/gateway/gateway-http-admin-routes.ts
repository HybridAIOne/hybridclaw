import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  RuntimeConfig,
  RuntimeDiscordChannelConfig,
} from '../config/runtime-config.js';
import { readJsonBody, sendJson } from './gateway-http-common.js';
import {
  createGatewayAdminAgent,
  deleteGatewayAdminAgent,
  deleteGatewayAdminSession,
  getGatewayAdminAgents,
  getGatewayAdminAudit,
  getGatewayAdminChannels,
  getGatewayAdminConfig,
  getGatewayAdminMcp,
  getGatewayAdminModels,
  getGatewayAdminOverview,
  getGatewayAdminScheduler,
  getGatewayAdminSessions,
  getGatewayAdminSkills,
  getGatewayAdminTools,
  getGatewayStatus,
  removeGatewayAdminChannel,
  removeGatewayAdminMcpServer,
  removeGatewayAdminSchedulerJob,
  saveGatewayAdminConfig,
  saveGatewayAdminModels,
  setGatewayAdminSchedulerJobPaused,
  setGatewayAdminSkillEnabled,
  updateGatewayAdminAgent,
  upsertGatewayAdminChannel,
  upsertGatewayAdminMcpServer,
  upsertGatewayAdminSchedulerJob,
} from './gateway-service.js';

function isRuntimeDiscordChannelConfig(
  value: unknown,
): value is RuntimeDiscordChannelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === 'off' || mode === 'mention' || mode === 'free';
}

export function handleApiEvents(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const sendEvent = (event: string, payload: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendSnapshot = (): void => {
    sendEvent('overview', getGatewayAdminOverview());
    sendEvent('status', getGatewayStatus());
  };

  sendSnapshot();
  const timer = setInterval(sendSnapshot, 10_000);

  req.on('close', () => {
    clearInterval(timer);
    if (!res.writableEnded) res.end();
  });
}

export function handleApiAdminOverview(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminOverview());
}

export async function handleApiAdminAgents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  if (method === 'GET') {
    sendJson(res, 200, getGatewayAdminAgents());
    return;
  }

  if (method === 'DELETE') {
    const pathname = url.pathname;
    const agentId = pathname.split('/').pop()?.trim() || '';
    if (!agentId || agentId === 'agents') {
      sendJson(res, 400, { error: 'Missing agent id in request path.' });
      return;
    }
    try {
      sendJson(res, 200, deleteGatewayAdminAgent(agentId));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const body = (await readJsonBody(req)) as {
    id?: unknown;
    name?: unknown;
    model?: unknown;
    chatbotId?: unknown;
    enableRag?: unknown;
    workspace?: unknown;
  };

  const payload = {
    id: String(body.id || '').trim(),
    name: typeof body.name === 'string' ? body.name : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    chatbotId: typeof body.chatbotId === 'string' ? body.chatbotId : undefined,
    enableRag: typeof body.enableRag === 'boolean' ? body.enableRag : undefined,
    workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
  };

  if (method === 'POST') {
    if (!payload.id) {
      sendJson(res, 400, { error: 'Expected non-empty `id` in request body.' });
      return;
    }
    try {
      sendJson(res, 200, createGatewayAdminAgent(payload));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'PUT') {
    const agentId = url.pathname.split('/').pop()?.trim() || '';
    if (!agentId || agentId === 'agents') {
      sendJson(res, 400, { error: 'Missing agent id in request path.' });
      return;
    }
    try {
      sendJson(
        res,
        200,
        updateGatewayAdminAgent(agentId, {
          name: payload.name,
          model: payload.model,
          chatbotId: payload.chatbotId,
          enableRag: payload.enableRag,
          workspace: payload.workspace,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, /not found/i.test(message) ? 404 : 400, {
        error: message,
      });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

export async function handleApiAdminModels(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, await getGatewayAdminModels());
    return;
  }

  const body = (await readJsonBody(req)) as {
    defaultModel?: unknown;
    hybridaiModels?: unknown;
    codexModels?: unknown;
  };
  sendJson(res, 200, await saveGatewayAdminModels(body));
}

export function handleApiAdminSessions(res: ServerResponse): void {
  sendJson(res, 200, { sessions: getGatewayAdminSessions() });
}

export function handleApiAdminSessionDelete(
  res: ServerResponse,
  url: URL,
): void {
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` query parameter.' });
    return;
  }
  sendJson(res, 200, deleteGatewayAdminSession(sessionId));
}

export async function handleApiAdminChannels(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminChannels());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const guildId = (url.searchParams.get('guildId') || '').trim();
    const channelId = (url.searchParams.get('channelId') || '').trim();
    sendJson(res, 200, removeGatewayAdminChannel({ guildId, channelId }));
    return;
  }

  const body = (await readJsonBody(req)) as {
    guildId?: string;
    channelId?: string;
    config?: Record<string, unknown>;
  };
  if (
    typeof body.guildId !== 'string' ||
    typeof body.channelId !== 'string' ||
    !isRuntimeDiscordChannelConfig(body.config)
  ) {
    sendJson(res, 400, {
      error:
        'Expected `guildId`, `channelId`, and object `config` with `mode` set to off, mention, or free.',
    });
    return;
  }

  sendJson(
    res,
    200,
    upsertGatewayAdminChannel({
      guildId: body.guildId,
      channelId: body.channelId,
      config: body.config,
    }),
  );
}

export async function handleApiAdminConfig(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminConfig());
    return;
  }

  const body = (await readJsonBody(req)) as { config?: unknown };
  if (
    !body.config ||
    typeof body.config !== 'object' ||
    Array.isArray(body.config)
  ) {
    sendJson(res, 400, { error: 'Expected object `config` in request body.' });
    return;
  }

  sendJson(res, 200, saveGatewayAdminConfig(body.config as RuntimeConfig));
}

export async function handleApiAdminScheduler(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminScheduler());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const source =
      (url.searchParams.get('source') || '').trim().toLowerCase() === 'task'
        ? 'task'
        : 'config';
    const rawId =
      source === 'task'
        ? (url.searchParams.get('taskId') || '').trim()
        : (url.searchParams.get('jobId') || '').trim();
    const jobId = (url.searchParams.get('jobId') || '').trim();
    sendJson(res, 200, removeGatewayAdminSchedulerJob(rawId || jobId, source));
    return;
  }

  if ((req.method || 'GET') === 'POST') {
    const body = (await readJsonBody(req)) as {
      jobId?: unknown;
      taskId?: unknown;
      source?: unknown;
      action?: unknown;
    };
    const source =
      String(body.source || '')
        .trim()
        .toLowerCase() === 'task'
        ? 'task'
        : 'config';
    const jobId = String(
      source === 'task' ? body.taskId || '' : body.jobId || '',
    ).trim();
    const action = String(body.action || '')
      .trim()
      .toLowerCase();
    if (action !== 'pause' && action !== 'resume') {
      sendJson(res, 400, {
        error: 'Expected scheduler action `pause` or `resume`.',
      });
      return;
    }
    sendJson(
      res,
      200,
      setGatewayAdminSchedulerJobPaused({
        jobId,
        paused: action === 'pause',
        source,
      }),
    );
    return;
  }

  const body = (await readJsonBody(req)) as { job?: unknown };
  sendJson(res, 200, upsertGatewayAdminSchedulerJob({ job: body.job }));
}

export async function handleApiAdminMcp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminMcp());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const name = (url.searchParams.get('name') || '').trim();
    sendJson(res, 200, removeGatewayAdminMcpServer(name));
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
    config?: unknown;
  };
  sendJson(
    res,
    200,
    upsertGatewayAdminMcpServer({
      name: String(body.name || ''),
      config: body.config,
    }),
  );
}

export function handleApiAdminAudit(res: ServerResponse, url: URL): void {
  const parsedLimit = parseInt(url.searchParams.get('limit') || '60', 10);
  const limit = Number.isNaN(parsedLimit) ? 60 : parsedLimit;
  sendJson(
    res,
    200,
    getGatewayAdminAudit({
      query: url.searchParams.get('query') || '',
      sessionId: url.searchParams.get('sessionId') || '',
      eventType: url.searchParams.get('eventType') || '',
      limit,
    }),
  );
}

export function handleApiAdminTools(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminTools());
}

export async function handleApiAdminSkills(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminSkills());
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
    enabled?: unknown;
  };
  if (typeof body.enabled !== 'boolean') {
    sendJson(res, 400, {
      error: 'Expected boolean `enabled` in request body.',
    });
    return;
  }
  sendJson(
    res,
    200,
    setGatewayAdminSkillEnabled({
      name: String(body.name || ''),
      enabled: body.enabled,
    }),
  );
}
