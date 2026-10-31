/**
 * Admin-only changes to the gateway's safety-rule snapshot, audited per save.
 * The HTTP auth/RBAC gate runs first; workers cannot choose their own rules.
 * This is not approval policy: disabling a guard never grants tool permission.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  normalizeDisabledSafetyRules,
  SAFETY_RULES,
  type SafetyRulesResponse,
} from '../../container/shared/safety-rules.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeConfig,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { isRecord } from '../utils/type-guards.js';
import type { AdminTokenAuditContext } from './gateway-admin-tokens.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export function getSafetyRules(): SafetyRulesResponse {
  const disabledRuleIds = getRuntimeConfig().security.disabledSafetyRules;
  return {
    disabledRuleIds,
    rules: SAFETY_RULES.map((rule) => ({
      ...rule,
      pattern: rule.pattern.toString(),
      enabled: !disabledRuleIds.includes(rule.id),
    })),
  };
}

export async function handleSafetyRulesAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  audit: AdminTokenAuditContext,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, getSafetyRules());
    return;
  }
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  // 16 KiB (implementation choice, 2026-10-31): this endpoint accepts small ID lists.
  const body = await readJsonBody(req, 16_384);
  if (
    !isRecord(body) ||
    !Array.isArray(body.disabledRuleIds) ||
    !Array.isArray(body.expectedDisabledRuleIds)
  ) {
    throw new GatewayRequestError(
      400,
      'Supply disabledRuleIds and expectedDisabledRuleIds arrays.',
    );
  }
  let disabled: string[];
  let expected: string[];
  try {
    disabled = normalizeDisabledSafetyRules(body.disabledRuleIds);
    expected = normalizeDisabledSafetyRules(body.expectedDisabledRuleIds);
  } catch {
    throw new GatewayRequestError(400, 'Choose only known safety rule IDs.');
  }
  const config = getRuntimeConfig();
  const previous = config.security.disabledSafetyRules;
  if (JSON.stringify(previous) !== JSON.stringify(expected)) {
    throw new GatewayRequestError(
      409,
      'Safety rules changed. Reload before saving.',
    );
  }
  if (JSON.stringify(previous) !== JSON.stringify(disabled)) {
    const next = structuredClone(config);
    next.security.disabledSafetyRules = disabled;
    saveRuntimeConfig(next, {
      actor: audit.actor,
      route: 'api.admin.safety-rules',
      source: 'admin-console',
    });
    recordAuditEvent({
      sessionId: audit.sessionId || 'admin:safety-rules',
      runId: makeAuditRunId('safety-rules'),
      event: {
        type: 'safety.rules_changed',
        actor: audit.actor || 'admin',
        previousDisabledRuleIds: previous,
        disabledRuleIds: disabled,
      },
    });
  }
  sendJson(res, 200, getSafetyRules());
}
