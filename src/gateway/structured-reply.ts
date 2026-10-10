/**
 * Forward card payloads without reinterpreting their data. Gateway types own
 * the schema; this projection does not render cards or derive action results.
 */
import type { GatewayChatResult } from './gateway-types.js';

export type StructuredReply = Pick<
  GatewayChatResult,
  'emailDraft' | 'cost' | 'costEstimate' | 'receipt' | 'scope' | 'apps'
>;

export function structuredReply(message: StructuredReply): StructuredReply {
  const { emailDraft, cost, costEstimate, receipt, scope, apps } = message;
  return { emailDraft, cost, costEstimate, receipt, scope, apps };
}
