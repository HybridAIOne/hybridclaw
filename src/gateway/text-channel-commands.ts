import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import {
  APPROVAL_SCOPE_MODES,
  APPROVE_TEXT_CHANNEL_USAGE,
  type ApprovalScopeMode,
} from '../approval-commands.js';
import { buildResponseText } from '../channels/discord/delivery.js';
import { parseIdArg, parseLowerArg } from '../command-parsing.js';
import {
  mapTuiSlashCommandToGatewayArgs,
  parseTuiSlashCommand,
} from '../tui-slash-command.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { formatError, formatInfo } from '../utils/text-format.js';
import { getApprovalPromptText } from './approval-presentation.js';
import { extractGatewayChatApprovalEvent } from './chat-approval.js';
import {
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
} from './chat-result.js';
import { recordCommandApproval } from './command-approval-trust.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import {
  handleGatewayCommand,
  renderGatewayCommand,
} from './gateway-service.js';
import type {
  GatewayChatResult,
  GatewayCommandResult,
} from './gateway-types.js';
import {
  cleanupExpiredPendingApprovals,
  clearPendingApproval,
  getPendingApproval,
  rememberPendingApproval,
} from './pending-approvals.js';

function isApprovalScopeMode(value: string): value is ApprovalScopeMode {
  return APPROVAL_SCOPE_MODES.includes(value as ApprovalScopeMode);
}

export interface HandledTextChannelApprovalResult {
  handled: true;
  sessionId: string;
  sessionKey?: string;
  mainSessionKey?: string;
  approvalId?: string;
  pendingApproval?: NonNullable<GatewayChatResult['pendingApproval']>;
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
  if (
    (isApprovalScopeMode(action) && action !== 'once') ||
    action === '2' ||
    action === '3' ||
    action === '4'
  ) {
    const mode =
      action === '2'
        ? 'session'
        : action === '3'
          ? 'agent'
          : action === '4'
            ? 'all'
            : action;
    return approvalId ? `yes ${approvalId} for ${mode}` : `yes for ${mode}`;
  }
  if (
    action === 'no' ||
    action === 'deny' ||
    action === 'skip' ||
    action === '5'
  ) {
    return withApprovalId('no');
  }
  return null;
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
  if (parseLowerArg(args, 0) !== 'approve') return null;

  await cleanupExpiredPendingApprovals();
  const pending = getPendingApproval(sessionId);
  const action = parseLowerArg(args, 1, { defaultValue: 'view' });
  const providedApprovalId = parseIdArg(args, 2);
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
      text: APPROVE_TEXT_CHANNEL_USAGE,
      artifacts: [],
    };
  }

  if (pending?.commandAction) {
    if (pending.userId !== userId) {
      return {
        handled: true,
        sessionId,
        text: 'No pending approval request for you in this session.',
        artifacts: [],
      };
    }
    if (!approvalId || approvalId !== pending.approvalId) {
      return {
        handled: true,
        sessionId,
        text: 'No matching pending approval request for this session.',
        artifacts: [],
      };
    }
    if (
      !(
        action === 'yes' ||
        action === '1' ||
        action === 'session' ||
        action === '2' ||
        action === 'agent' ||
        action === '3' ||
        action === 'all' ||
        action === '4' ||
        action === 'no' ||
        action === 'deny' ||
        action === 'skip' ||
        action === '5'
      )
    ) {
      return {
        handled: true,
        sessionId,
        text: 'This approval only supports `/approve yes [approval_id]`, `/approve session [approval_id]`, or `/approve no [approval_id]`.',
        artifacts: [],
      };
    }

    if (
      (action === 'session' || action === '2') &&
      pending.commandAction.allowSession !== true
    ) {
      return {
        handled: true,
        sessionId,
        text: 'Session trust is unavailable for this approval.',
        artifacts: [],
      };
    }
    if (
      (action === 'agent' || action === '3') &&
      pending.commandAction.allowAgent !== true
    ) {
      return {
        handled: true,
        sessionId,
        text: 'Agent trust is unavailable for this approval.',
        artifacts: [],
      };
    }
    if (
      (action === 'all' || action === '4') &&
      pending.commandAction.allowAll !== true
    ) {
      return {
        handled: true,
        sessionId,
        text: 'Workspace allowlist trust is unavailable for this approval.',
        artifacts: [],
      };
    }

    await clearPendingApproval(sessionId, { disableButtons: true });
    if (
      action === 'no' ||
      action === 'deny' ||
      action === 'skip' ||
      action === '5'
    ) {
      return {
        handled: true,
        sessionId,
        text: renderTextChannelCommandResult({
          kind: 'info',
          title: pending.commandAction.denyTitle || 'Approval Denied',
          text: pending.commandAction.denyText || 'Request denied.',
        }),
        artifacts: [],
      };
    }

    const approvalMode =
      action === 'session' || action === '2' ? 'session' : 'once';
    if (pending.commandAction.actionKey) {
      recordCommandApproval({
        sessionId,
        actionKey: pending.commandAction.actionKey,
        mode: approvalMode,
      });
    }

    const commandResult = await handleGatewayCommand({
      sessionId,
      guildId,
      channelId,
      userId,
      username,
      args: pending.commandAction.approveArgs,
    });
    return {
      handled: true,
      sessionId: commandResult.sessionId || sessionId,
      sessionKey: commandResult.sessionKey,
      mainSessionKey: commandResult.mainSessionKey,
      text: renderTextChannelCommandResult(commandResult),
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
      prompt: getApprovalPromptText(pendingApproval, resultText),
      userId: pendingApproval.escalationTarget?.recipient || userId,
      expiresAt: pendingApproval.expiresAt,
    });
    return {
      handled: true,
      sessionId: approvalSessionId,
      sessionKey: approvalResult.sessionKey,
      mainSessionKey: approvalResult.mainSessionKey,
      approvalId: pendingApproval.approvalId,
      pendingApproval: approvalResult.pendingApproval,
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
