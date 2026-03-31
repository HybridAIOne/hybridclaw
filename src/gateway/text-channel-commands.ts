import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import {
  buildResponseText,
  formatError,
  formatInfo,
} from '../channels/discord/delivery.js';
import {
  mapTuiSlashCommandToGatewayArgs,
  parseTuiSlashCommand,
} from '../tui-slash-command.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { extractGatewayChatApprovalEvent } from './chat-approval.js';
import {
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
} from './chat-result.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { renderGatewayCommand } from './gateway-service.js';
import type { GatewayCommandResult } from './gateway-types.js';
import {
  cleanupExpiredPendingApprovals,
  clearPendingApproval,
  getPendingApproval,
  type PendingApprovalPrompt,
  setPendingApproval,
} from './pending-approvals.js';

const APPROVAL_PROMPT_DEFAULT_TTL_MS = 120_000;

export interface HandledTextChannelApprovalResult {
  handled: true;
  sessionId: string;
  sessionKey?: string;
  mainSessionKey?: string;
  approvalId?: string;
  text: string | null;
  artifacts: ArtifactMetadata[];
}

export function resolveTextChannelSlashCommands(
  content: string,
): string[][] | null {
  if (!content.trim().startsWith('/')) return null;

  const parsed = parseTuiSlashCommand(content);
  if (!parsed.cmd || parsed.parts.length === 0) return null;

  if (parsed.cmd === 'approve') {
    return [parsed.parts];
  }

  if (parsed.cmd === 'info') {
    return [['bot', 'info'], ['model', 'info'], ['status']];
  }

  const args = mapTuiSlashCommandToGatewayArgs(parsed.parts);
  return args ? [args] : null;
}

export function renderTextChannelCommandResult(
  result: GatewayCommandResult,
): string {
  if (result.kind === 'error') {
    return formatError(result.title || 'Error', result.text);
  }
  if (result.kind === 'info') {
    return formatInfo(result.title || 'Info', result.text);
  }
  return renderGatewayCommand(result);
}

function buildApprovalUserMessage(params: {
  action: string;
  approvalId: string;
}): string | null {
  const action = params.action.trim().toLowerCase();
  const approvalId = params.approvalId.trim();
  const withApprovalId = (base: string): string =>
    approvalId ? `${base} ${approvalId}` : base;

  if (action === 'yes' || action === '1') {
    return withApprovalId('yes');
  }
  if (action === 'session' || action === '2') {
    return approvalId ? `yes ${approvalId} for session` : 'yes for session';
  }
  if (action === 'agent' || action === '3') {
    return approvalId ? `yes ${approvalId} for agent` : 'yes for agent';
  }
  if (
    action === 'no' ||
    action === 'deny' ||
    action === 'skip' ||
    action === '4'
  ) {
    return withApprovalId('no');
  }
  return null;
}

export async function rememberPendingApproval(params: {
  sessionId: string;
  approvalId: string;
  prompt: string;
  userId: string;
  expiresAt?: number | null;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<void> {
  const createdAt = Date.now();
  const expiresAt =
    typeof params.expiresAt === 'number' && Number.isFinite(params.expiresAt)
      ? Math.max(createdAt + 15_000, params.expiresAt)
      : createdAt + APPROVAL_PROMPT_DEFAULT_TTL_MS;
  const entry: PendingApprovalPrompt = {
    approvalId: params.approvalId,
    prompt: params.prompt,
    createdAt,
    expiresAt,
    userId: params.userId,
    resolvedAt: null,
    disableButtons: params.disableButtons ?? null,
    disableTimeout: null,
  };
  entry.disableTimeout = setTimeout(
    () => {
      void clearPendingApproval(params.sessionId, { disableButtons: true });
    },
    Math.max(0, expiresAt - Date.now()),
  );
  await setPendingApproval(params.sessionId, entry);
}

export async function handleTextChannelApprovalCommand(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string | null;
  args: string[];
}): Promise<HandledTextChannelApprovalResult | null> {
  const { sessionId, guildId, channelId, userId, username, args } = params;
  if ((args[0] || '').toLowerCase() !== 'approve') return null;

  await cleanupExpiredPendingApprovals();
  const pending = getPendingApproval(sessionId);
  const action = (args[1] || 'view').trim().toLowerCase();
  const providedApprovalId = (args[2] || '').trim();
  const currentApprovalId = pending?.approvalId || '';
  const approvalId = providedApprovalId || currentApprovalId;

  if (action === 'view' || action === 'status' || action === 'show') {
    if (!pending || pending.userId !== userId) {
      return {
        handled: true,
        sessionId,
        text: 'No pending approval request for you in this session.',
        artifacts: [],
      };
    }
    return {
      handled: true,
      sessionId,
      approvalId: pending.approvalId,
      text: formatInfo('Pending Approval', pending.prompt),
      artifacts: [],
    };
  }

  const approvalContent = buildApprovalUserMessage({ action, approvalId });
  if (!approvalContent) {
    return {
      handled: true,
      sessionId,
      text: 'Usage: `/approve action:view|yes|session|agent|no [approval_id]`',
      artifacts: [],
    };
  }

  if (!approvalId && !pending) {
    return {
      handled: true,
      sessionId,
      text: 'No pending approval request for this session.',
      artifacts: [],
    };
  }

  const approvalResult = normalizePendingApprovalReply(
    normalizePlaceholderToolReply(
      await handleGatewayMessage({
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content: approvalContent,
        media: [],
      }),
    ),
  );
  if (approvalResult.status === 'error') {
    return {
      handled: true,
      sessionId: approvalResult.sessionId || sessionId,
      sessionKey: approvalResult.sessionKey,
      mainSessionKey: approvalResult.mainSessionKey,
      text: formatError(
        'Approval Error',
        approvalResult.error || 'Unknown error',
      ),
      artifacts: [],
    };
  }

  const approvalSessionId = approvalResult.sessionId || sessionId;
  if (isSilentReply(approvalResult.result)) {
    await clearPendingApproval(approvalSessionId, { disableButtons: true });
    return {
      handled: true,
      sessionId: approvalSessionId,
      sessionKey: approvalResult.sessionKey,
      mainSessionKey: approvalResult.mainSessionKey,
      text: null,
      artifacts: approvalResult.artifacts || [],
    };
  }

  const approvalResultText = stripSilentToken(String(approvalResult.result));
  if (!approvalResultText.trim()) {
    await clearPendingApproval(approvalSessionId, { disableButtons: true });
    return {
      handled: true,
      sessionId: approvalSessionId,
      sessionKey: approvalResult.sessionKey,
      mainSessionKey: approvalResult.mainSessionKey,
      text: null,
      artifacts: approvalResult.artifacts || [],
    };
  }

  const resultText = buildResponseText(
    approvalResultText,
    approvalResult.toolsUsed,
  );
  const pendingApproval = extractGatewayChatApprovalEvent(approvalResult);
  if (pendingApproval) {
    await rememberPendingApproval({
      sessionId: approvalSessionId,
      approvalId: pendingApproval.approvalId,
      prompt: pendingApproval.prompt || resultText,
      userId,
      expiresAt: pendingApproval.expiresAt,
    });
    return {
      handled: true,
      sessionId: approvalSessionId,
      sessionKey: approvalResult.sessionKey,
      mainSessionKey: approvalResult.mainSessionKey,
      approvalId: pendingApproval.approvalId,
      text: formatInfo('Pending Approval', resultText),
      artifacts: approvalResult.artifacts || [],
    };
  }

  await clearPendingApproval(approvalSessionId, { disableButtons: true });
  return {
    handled: true,
    sessionId: approvalSessionId,
    sessionKey: approvalResult.sessionKey,
    mainSessionKey: approvalResult.mainSessionKey,
    text: resultText,
    artifacts: approvalResult.artifacts || [],
  };
}
