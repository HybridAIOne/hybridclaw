import type { GatewayMessageComponents } from './gateway-types.js';

export function buildResetConfirmationComponents(params: {
  sessionId: string;
  userId: string;
}): GatewayMessageComponents {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          label: 'Reset Session',
          custom_id: buildResetConfirmationCustomId({
            action: 'yes',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
        {
          type: 2,
          style: 2,
          label: 'Cancel',
          custom_id: buildResetConfirmationCustomId({
            action: 'no',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
      ],
    },
  ];
}

export function buildResetConfirmationCustomId(params: {
  action: 'yes' | 'no';
  sessionId: string;
  userId: string;
}): string {
  return `reset:${params.action}:${params.userId}:${encodeURIComponent(params.sessionId)}`;
}

export function parseResetConfirmationCustomId(
  customId: string,
): { action: 'yes' | 'no'; sessionId: string; userId: string } | null {
  const match = customId.match(/^reset:(yes|no):(\d{16,22}):(.+)$/);
  if (!match) return null;
  const [, action, userId, encodedSessionId] = match;
  try {
    return {
      action: action === 'yes' ? 'yes' : 'no',
      userId,
      sessionId: decodeURIComponent(encodedSessionId),
    };
  } catch {
    return null;
  }
}
