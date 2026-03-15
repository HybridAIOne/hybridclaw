import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import type {
  ApprovalContinuation,
  ApprovalResponse,
  PendingApproval,
} from '../types.js';
import { extractGatewayChatApprovalEvent } from './chat-approval.js';
import {
  filterChatResultForSession,
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import type { GatewayChatRequest } from './gateway-service.js';
import type {
  GatewayChatApprovalEvent,
  GatewayChatResult,
} from './gateway-types.js';
import {
  claimPendingApprovalByApprovalId,
  cleanupExpiredPendingApprovals,
  clearPendingApproval,
  findPendingApprovalByApprovalId,
  getPendingApproval,
  type PendingApprovalPrompt,
  setPendingApproval,
} from './pending-approvals.js';

const APPROVAL_PROMPT_DEFAULT_TTL_MS = 120_000;

export const APPROVAL_COMMAND_USAGE_TEXT =
  'Usage: `/approve action:view|yes|session|agent|no [approval_id]`';
export const NO_PENDING_APPROVAL_TEXT =
  'No pending approval request for this session.';
export const NO_PENDING_APPROVAL_FOR_USER_TEXT =
  'No pending approval request for you in this session.';
export const APPROVAL_ALREADY_HANDLED_TEXT =
  'This approval has already been handled.';

type ApprovalDirective = 'yes' | 'yes for session' | 'yes for agent' | 'no';

type ClaimedPendingApproval = {
  sessionId: string;
  entry: PendingApprovalPrompt;
};

export type GatewayApprovalCommandOutcome =
  | { handled: false }
  | { handled: true; kind: 'view'; pending: PendingApprovalPrompt }
  | {
      handled: true;
      kind: 'usage' | 'not_found' | 'unauthorized' | 'already_handled';
    }
  | { handled: true; kind: 'error'; errorMessage: string }
  | {
      handled: true;
      kind: 'replayed';
      rawResult: GatewayChatResult;
      normalizedResult: GatewayChatResult;
      pendingApproval: GatewayChatApprovalEvent | null;
      resultText: string;
      silent: boolean;
    };

export interface HandleGatewayApprovalCommandParams {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  args: string[];
  replayMessage: (
    request: GatewayChatRequest & {
      approvalResponse: ApprovalResponse;
      approvalContinuation?: ApprovalContinuation;
      media: [];
      source: 'approval';
    },
  ) => Promise<GatewayChatResult>;
  clearOptions?: { disableButtons?: boolean };
}

export async function rememberPendingApprovalPrompt(params: {
  sessionId: string;
  approvalId: string;
  prompt: string;
  originalUserContent: string;
  continuation?: ApprovalContinuation | null;
  userId: string;
  expiresAt?: number | null;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<PendingApprovalPrompt> {
  const createdAt = Date.now();
  const expiresAt =
    typeof params.expiresAt === 'number' && Number.isFinite(params.expiresAt)
      ? Math.max(createdAt + 15_000, params.expiresAt)
      : createdAt + APPROVAL_PROMPT_DEFAULT_TTL_MS;
  const entry: PendingApprovalPrompt = {
    approvalId: params.approvalId,
    prompt: params.prompt,
    originalUserContent: params.originalUserContent,
    continuation: params.continuation ?? null,
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
  return entry;
}

export async function rememberPendingApprovalEvent(params: {
  sessionId: string;
  approval: Pick<PendingApproval, 'approvalId' | 'prompt' | 'expiresAt'>;
  fallbackPrompt?: string;
  originalUserContent: string;
  continuation?: ApprovalContinuation | null;
  userId: string;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<PendingApprovalPrompt> {
  const prompt =
    params.approval.prompt.trim() ||
    params.fallbackPrompt?.trim() ||
    'Approval required.';
  return rememberPendingApprovalPrompt({
    sessionId: params.sessionId,
    approvalId: params.approval.approvalId,
    prompt,
    originalUserContent: params.originalUserContent,
    continuation: params.continuation,
    userId: params.userId,
    expiresAt: params.approval.expiresAt,
    disableButtons: params.disableButtons,
  });
}

export async function rememberPendingApprovalFromChatResult(params: {
  sessionId: string;
  result: GatewayChatResult;
  originalUserContent: string;
  continuation?: ApprovalContinuation | null;
  userId: string;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<GatewayChatApprovalEvent | null> {
  const approval = extractGatewayChatApprovalEvent(params.result);
  if (!approval) return null;
  await rememberPendingApprovalEvent({
    sessionId: params.sessionId,
    approval,
    fallbackPrompt: String(params.result.result || '').trim(),
    originalUserContent: params.originalUserContent,
    continuation: params.continuation,
    userId: params.userId,
    disableButtons: params.disableButtons,
  });
  return approval;
}

export async function clearGatewayPendingApproval(
  sessionId: string,
  options?: { disableButtons?: boolean },
): Promise<PendingApprovalPrompt | null> {
  return clearPendingApproval(sessionId, options);
}

function parseApprovalDirective(action: string): ApprovalDirective | null {
  if (action === 'yes' || action === '1') return 'yes';
  if (action === 'session' || action === '2') return 'yes for session';
  if (action === 'agent' || action === '3') return 'yes for agent';
  if (
    action === 'no' ||
    action === 'deny' ||
    action === 'skip' ||
    action === '4'
  ) {
    return 'no';
  }
  return null;
}

function buildApprovalResponse(
  approvalId: string,
  directive: ApprovalDirective,
): ApprovalResponse {
  if (directive === 'no') {
    return {
      approvalId,
      decision: 'deny',
      mode: 'once',
    };
  }
  if (directive === 'yes for session') {
    return {
      approvalId,
      decision: 'approve',
      mode: 'session',
    };
  }
  if (directive === 'yes for agent') {
    return {
      approvalId,
      decision: 'approve',
      mode: 'agent',
    };
  }
  return {
    approvalId,
    decision: 'approve',
    mode: 'once',
  };
}

function isMissingPendingApprovalText(text: string): boolean {
  return (
    text === 'There is no pending approval request right now.' ||
    text.startsWith('No pending approval found for id ')
  );
}

function normalizeApprovalReplayResult(
  sessionId: string,
  result: GatewayChatResult,
): GatewayChatResult {
  return filterChatResultForSession(
    sessionId,
    normalizePendingApprovalReply(
      normalizePlaceholderToolReply(normalizeSilentMessageSendReply(result)),
    ),
  );
}

function resolveVisiblePendingApproval(params: {
  sessionId: string;
  userId: string;
  approvalId: string;
}):
  | { kind: 'view'; pending: PendingApprovalPrompt }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' } {
  const currentPending = getPendingApproval(params.sessionId);
  const currentApprovalId = currentPending?.approvalId || '';
  const visiblePending =
    params.approvalId && params.approvalId !== currentApprovalId
      ? findPendingApprovalByApprovalId(params.approvalId)?.entry || null
      : currentPending;
  if (!visiblePending) return { kind: 'not_found' };
  if (visiblePending.userId !== params.userId) return { kind: 'unauthorized' };
  return { kind: 'view', pending: visiblePending };
}

function claimApproval(params: {
  approvalId: string;
  userId: string;
}):
  | { kind: 'claimed'; claimed: ClaimedPendingApproval }
  | { kind: 'not_found' | 'unauthorized' | 'already_handled' } {
  const claimed = claimPendingApprovalByApprovalId(params);
  if (claimed.status === 'claimed') {
    return {
      kind: 'claimed',
      claimed: {
        sessionId: claimed.sessionId,
        entry: claimed.entry,
      },
    };
  }
  if (claimed.status === 'unauthorized') return { kind: 'unauthorized' };
  if (claimed.status === 'already_handled') return { kind: 'already_handled' };
  return { kind: 'not_found' };
}

export async function handleGatewayApprovalCommand(
  params: HandleGatewayApprovalCommandParams,
): Promise<GatewayApprovalCommandOutcome> {
  if ((params.args[0] || '').toLowerCase() !== 'approve') {
    return { handled: false };
  }

  await cleanupExpiredPendingApprovals();

  const pending = getPendingApproval(params.sessionId);
  const action = (params.args[1] || 'view').trim().toLowerCase();
  const approvalId = (params.args[2] || '').trim() || pending?.approvalId || '';

  if (action === 'view' || action === 'status' || action === 'show') {
    const visible = resolveVisiblePendingApproval({
      sessionId: params.sessionId,
      userId: params.userId,
      approvalId,
    });
    if (visible.kind === 'view') {
      return {
        handled: true,
        kind: 'view',
        pending: visible.pending,
      };
    }
    return {
      handled: true,
      kind: visible.kind,
    };
  }

  const directive = parseApprovalDirective(action);
  if (!directive) {
    return {
      handled: true,
      kind: 'usage',
    };
  }
  if (!approvalId && !pending) {
    return {
      handled: true,
      kind: 'not_found',
    };
  }

  const claimedResult = claimApproval({
    approvalId,
    userId: params.userId,
  });
  if (claimedResult.kind !== 'claimed') {
    return {
      handled: true,
      kind: claimedResult.kind,
    };
  }

  const { claimed } = claimedResult;
  let rawResult: GatewayChatResult;
  let replayedContinuation: ApprovalContinuation | undefined;
  try {
    rawResult = await params.replayMessage({
      sessionId: claimed.sessionId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      username: params.username,
      content: claimed.entry.originalUserContent,
      approvalResponse: buildApprovalResponse(approvalId, directive),
      approvalContinuation: claimed.entry.continuation || undefined,
      onPendingApprovalCaptured: ({ continuation }) => {
        replayedContinuation = continuation;
      },
      media: [],
      source: 'approval',
    });
  } catch (error) {
    claimed.entry.resolvedAt = null;
    return {
      handled: true,
      kind: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const normalizedResult = normalizeApprovalReplayResult(
    claimed.sessionId,
    rawResult,
  );
  if (normalizedResult.status === 'error') {
    claimed.entry.resolvedAt = null;
    return {
      handled: true,
      kind: 'error',
      errorMessage: normalizedResult.error || 'Unknown error',
    };
  }

  const resultText = stripSilentToken(
    String(normalizedResult.result || ''),
  ).trim();
  if (isMissingPendingApprovalText(resultText)) {
    claimed.entry.resolvedAt = null;
  }

  const pendingApproval = extractGatewayChatApprovalEvent(normalizedResult);
  if (pendingApproval) {
    await rememberPendingApprovalEvent({
      sessionId: claimed.sessionId,
      approval: pendingApproval,
      fallbackPrompt: resultText,
      originalUserContent: claimed.entry.originalUserContent,
      continuation: replayedContinuation ?? claimed.entry.continuation,
      userId: params.userId,
    });
  } else {
    await clearPendingApproval(claimed.sessionId, params.clearOptions);
  }

  return {
    handled: true,
    kind: 'replayed',
    rawResult,
    normalizedResult,
    pendingApproval,
    resultText,
    silent: isSilentReply(rawResult.result),
  };
}
