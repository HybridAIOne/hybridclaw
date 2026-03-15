import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type DiscordToolActionRequest,
  normalizeDiscordToolAction,
} from '../channels/discord/tool-actions.js';
import { runMessageToolAction } from '../channels/message/tool-actions.js';
import { claimQueuedProactiveMessages } from '../memory/db.js';
import {
  APPROVAL_ALREADY_HANDLED_TEXT,
  APPROVAL_COMMAND_USAGE_TEXT,
  handleGatewayApprovalCommand,
  NO_PENDING_APPROVAL_FOR_USER_TEXT,
  NO_PENDING_APPROVAL_TEXT,
} from './approval-middleware.js';
import { readJsonBody, sendJson } from './gateway-http-common.js';
import {
  getGatewayAgents,
  getGatewayHistory,
  handleGatewayCommand,
  handleGatewayMessage,
} from './gateway-service.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';

type ApiMessageActionRequestBody = Partial<DiscordToolActionRequest>;

function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

function infoCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function errorCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

async function handleApiApprovalCommand(
  body: Partial<GatewayCommandRequest>,
): Promise<GatewayCommandResult | null> {
  const args = Array.isArray(body.args)
    ? body.args.map((value) => String(value))
    : [];
  const outcome = await handleGatewayApprovalCommand({
    sessionId: body.sessionId || 'web:default',
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    userId: body.userId || 'web-user',
    username: body.username ?? 'web',
    args,
    replayMessage: handleGatewayMessage,
  });
  if (!outcome.handled) return null;
  if (outcome.kind === 'view') {
    return infoCommand('Pending Approval', outcome.pending.prompt);
  }
  if (outcome.kind === 'usage') {
    return plainCommand(APPROVAL_COMMAND_USAGE_TEXT);
  }
  if (outcome.kind === 'not_found') {
    return plainCommand(NO_PENDING_APPROVAL_TEXT);
  }
  if (outcome.kind === 'unauthorized') {
    return plainCommand(NO_PENDING_APPROVAL_FOR_USER_TEXT);
  }
  if (outcome.kind === 'already_handled') {
    return plainCommand(APPROVAL_ALREADY_HANDLED_TEXT);
  }
  if (outcome.kind === 'error') {
    return errorCommand('Approval Error', outcome.errorMessage);
  }
  if (outcome.kind !== 'replayed') {
    return plainCommand(NO_PENDING_APPROVAL_TEXT);
  }
  if (outcome.pendingApproval) {
    return infoCommand(
      'Pending Approval',
      outcome.resultText ||
        outcome.pendingApproval.prompt ||
        'Approval required.',
    );
  }
  return plainCommand(outcome.resultText || 'Done.');
}

export async function handleApiCommand(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<GatewayCommandRequest>;
  const approvalResult = await handleApiApprovalCommand(body);
  if (approvalResult) {
    sendJson(res, approvalResult.kind === 'error' ? 400 : 200, approvalResult);
    return;
  }

  const args = Array.isArray(body.args)
    ? body.args.map((value) => String(value))
    : [];
  if (args.length === 0) {
    sendJson(res, 400, {
      error: 'Missing command. Provide non-empty `args` array.',
    });
    return;
  }

  const commandRequest: GatewayCommandRequest = {
    sessionId: body.sessionId || 'web:default',
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    args,
    userId: body.userId ?? null,
    username: body.username ?? null,
  };
  const result = await handleGatewayCommand(commandRequest);
  sendJson(res, result.kind === 'error' ? 400 : 200, result);
}

export async function handleApiMessageAction(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiMessageActionRequestBody;
  const action =
    typeof body.action === 'string'
      ? normalizeDiscordToolAction(body.action)
      : null;
  if (!action) {
    sendJson(res, 400, {
      error:
        'Invalid `action`. Allowed: "read", "member-info", "channel-info", "send", "react", "quote-reply", "edit", "delete", "pin", "unpin", "thread-create", "thread-reply".',
    });
    return;
  }

  const request: DiscordToolActionRequest = {
    action,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
    guildId: typeof body.guildId === 'string' ? body.guildId : undefined,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    memberId: typeof body.memberId === 'string' ? body.memberId : undefined,
    username: typeof body.username === 'string' ? body.username : undefined,
    user: typeof body.user === 'string' ? body.user : undefined,
    resolveAmbiguous:
      body.resolveAmbiguous === 'best' || body.resolveAmbiguous === 'error'
        ? body.resolveAmbiguous
        : undefined,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    before: typeof body.before === 'string' ? body.before : undefined,
    after: typeof body.after === 'string' ? body.after : undefined,
    around: typeof body.around === 'string' ? body.around : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
    components:
      Array.isArray(body.components) ||
      (body.components !== null && typeof body.components === 'object')
        ? body.components
        : undefined,
    contextChannelId:
      typeof body.contextChannelId === 'string'
        ? body.contextChannelId
        : undefined,
    messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
    emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    autoArchiveDuration:
      typeof body.autoArchiveDuration === 'number'
        ? body.autoArchiveDuration
        : undefined,
  };

  const result = await runMessageToolAction(request);
  sendJson(res, 200, result);
}

export function handleApiHistory(res: ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get('sessionId') || 'web:default';
  const parsedLimit = parseInt(url.searchParams.get('limit') || '40', 10);
  const limit = Number.isNaN(parsedLimit) ? 40 : parsedLimit;
  const history = getGatewayHistory(sessionId, limit);
  sendJson(res, 200, { sessionId, history });
}

export function handleApiAgents(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAgents());
}

export function handleApiProactivePull(res: ServerResponse, url: URL): void {
  const channelId = (url.searchParams.get('channelId') || '').trim();
  if (!channelId) {
    sendJson(res, 400, { error: 'Missing `channelId` query parameter.' });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
  const messages = claimQueuedProactiveMessages(channelId, limit);
  sendJson(res, 200, { channelId, messages });
}

export function handleApiShutdown(res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    message: 'Gateway shutdown requested.',
  });
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 50);
}
