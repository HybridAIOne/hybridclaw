/**
 * Additive `/track` contract for both mobile clients and the track tool.
 * Commands carry user decisions; tools can describe state and link evidence only.
 */

import { plainCommand } from '../gateway/gateway-command-results.js';
import type { GatewayCommandResult } from '../gateway/gateway-types.js';
import { chatSafeJson } from '../gateway/schedule-command.js';
import type { Session } from '../types/session.js';
import { isRecord } from '../utils/type-guards.js';
import {
  followThroughCapabilities,
  followThroughDetail,
  followThroughSummary,
  getTracked,
  mutateFollowThrough,
  verifiedTrackOwner,
} from './follow-through.js';
import { listTracked, TrackError } from './track-store.js';

export function handleFollowThroughCommand(
  session: Session,
  sub: string,
  rest: string[],
): GatewayCommandResult | null {
  if (!['overview', 'get', 'update'].includes(sub)) return null;
  verifiedTrackOwner(session);
  const args = rest.filter((arg) => arg !== '--json');
  if (sub === 'overview' && args.length === 0) {
    return plainCommand(
      chatSafeJson({
        version: 1,
        follow_through: followThroughCapabilities,
        items: listTracked(session).map((item) =>
          followThroughSummary(session, item),
        ),
      }),
    );
  }
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new TrackError('Give the item id.');
  if (sub === 'get' && args.length === 1) {
    return plainCommand(
      chatSafeJson({
        version: 1,
        item: followThroughDetail(session, getTracked(session, id)),
      }),
    );
  }
  if (
    sub !== 'update' ||
    args.length !== 2 ||
    !/^[A-Za-z0-9_-]{1,50000}$/.test(args[1])
  )
    throw new TrackError('Expected update <id> <base64url JSON>.');
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(args[1], 'base64url').toString('utf8'));
  } catch {
    throw new TrackError('Invalid follow-through change.');
  }
  if (!isRecord(body)) throw new TrackError('Expected a change object.');
  return plainCommand(
    chatSafeJson({
      version: 1,
      ...mutateFollowThrough(session, id, body, 'user'),
    }),
  );
}

export function runFollowThroughTool(
  session: Session,
  body: Record<string, unknown>,
  id: number,
): string {
  if (body.action === 'get')
    return JSON.stringify(
      followThroughDetail(session, getTracked(session, id)),
    );
  // Discard transport fields; an owner or actor in tool arguments grants nothing.
  const { sessionId: _session, id: _id, ...change } = body;
  return JSON.stringify(mutateFollowThrough(session, id, change, 'agent'));
}
