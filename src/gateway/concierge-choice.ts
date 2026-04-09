import type { ConciergeProfile } from './concierge-routing.js';
import type { GatewayMessageComponents } from './gateway-types.js';

export function buildConciergeChoiceComponents(params: {
  sessionId: string;
  userId: string;
}): GatewayMessageComponents {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: 'As soon as possible',
          custom_id: buildConciergeChoiceCustomId({
            profile: 'asap',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
        {
          type: 2,
          style: 1,
          label: 'Can wait a bit',
          custom_id: buildConciergeChoiceCustomId({
            profile: 'balanced',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
        {
          type: 2,
          style: 2,
          label: 'No hurry',
          custom_id: buildConciergeChoiceCustomId({
            profile: 'no_hurry',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
      ],
    },
  ];
}

export function buildConciergeChoiceCustomId(params: {
  profile: ConciergeProfile;
  sessionId: string;
  userId: string;
}): string {
  return `concierge:${params.profile}:${params.userId}:${encodeURIComponent(params.sessionId)}`;
}

export function parseConciergeChoiceCustomId(
  customId: string,
): { profile: ConciergeProfile; sessionId: string; userId: string } | null {
  const match = customId.match(
    /^concierge:(asap|balanced|no_hurry):(\d{16,22}):(.+)$/,
  );
  if (!match) return null;
  const [, profile, userId, encodedSessionId] = match;
  try {
    return {
      profile: profile as ConciergeProfile,
      userId,
      sessionId: decodeURIComponent(encodedSessionId),
    };
  } catch {
    return null;
  }
}
