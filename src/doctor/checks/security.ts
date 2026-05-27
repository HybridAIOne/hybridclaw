import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config/config.js';
import {
  getRuntimeConfig,
  isSecurityTrustAccepted,
} from '../../config/runtime-config.js';
import {
  summarizeInstructionIntegrity,
  syncRuntimeInstructionCopies,
  verifyInstructionIntegrity,
} from '../../security/instruction-integrity.js';
import { listStoredRuntimeSecretNames } from '../../security/runtime-secrets.js';
import type { DiagResult } from '../types.js';
import { findExistingPath, makeResult, severityFrom } from '../utils.js';

const BOUND_DOMAIN_SUFFIX = '_BOUND_DOMAIN';
const DOMAIN_BINDING_EXEMPT_SECRET_NAMES = new Set([
  'GOG_ACCESS_TOKEN',
  'GOOGLE_WORKSPACE_CLI_TOKEN',
  'HUBSPOT_ACCESS_TOKEN',
]);
const NON_BEARER_SECRET_NAMES = new Set([
  'DISCORD_TOKEN',
  'GATEWAY_API_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'THREEMA_GATEWAY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'WEB_API_TOKEN',
]);

function checkWritablePath(targetPath: string): boolean {
  try {
    fs.accessSync(findExistingPath(targetPath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isLikelyBearerSecretName(name: string): boolean {
  if (
    DOMAIN_BINDING_EXEMPT_SECRET_NAMES.has(name) ||
    NON_BEARER_SECRET_NAMES.has(name) ||
    name.endsWith(BOUND_DOMAIN_SUFFIX)
  ) {
    return false;
  }
  return (
    name.endsWith('_ACCESS_TOKEN') ||
    name.endsWith('_API_TOKEN') ||
    name.endsWith('_BEARER') ||
    name.endsWith('_BEARER_TOKEN') ||
    name.endsWith('_JWT')
  );
}

function findUnboundBearerSecretNames(): string[] {
  let secretNames: string[];
  try {
    secretNames = listStoredRuntimeSecretNames();
  } catch {
    return [];
  }
  const stored = new Set(secretNames);
  return secretNames.filter(
    (name) =>
      isLikelyBearerSecretName(name) &&
      !stored.has(`${name}${BOUND_DOMAIN_SUFFIX}`),
  );
}

export async function checkSecurity(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const trustAccepted = isSecurityTrustAccepted(config);
  const instructionIntegrity = verifyInstructionIntegrity();
  const auditDir = path.join(DATA_DIR, 'audit');
  const auditWritable = checkWritablePath(auditDir);
  const unboundBearerSecretNames = findUnboundBearerSecretNames();

  const integrityHasSourceGap = instructionIntegrity.files.some(
    (file) => file.status === 'source_missing',
  );
  const integrityHasModified = instructionIntegrity.files.some(
    (file) => file.status === 'modified',
  );
  const integrityHasMissing = instructionIntegrity.files.some(
    (file) => file.status === 'missing',
  );

  const integritySeverity: DiagResult['severity'] = integrityHasSourceGap
    ? 'error'
    : integrityHasModified || integrityHasMissing
      ? 'warn'
      : 'ok';

  const severity = severityFrom([
    ...(trustAccepted ? [] : ['error' as const]),
    ...(integritySeverity === 'ok' ? [] : [integritySeverity]),
    ...(auditWritable ? [] : ['error' as const]),
    ...(unboundBearerSecretNames.length > 0 ? ['warn' as const] : []),
  ]);

  const messageParts = [];
  messageParts.push(
    trustAccepted ? 'Trust model accepted' : 'Trust model not accepted',
  );
  messageParts.push(
    instructionIntegrity.ok
      ? 'instruction integrity OK'
      : summarizeInstructionIntegrity(instructionIntegrity),
  );
  messageParts.push(
    auditWritable ? 'audit trail writable' : 'audit trail not writable',
  );
  if (unboundBearerSecretNames.length > 0) {
    messageParts.push(
      `bearer domain binding missing for ${unboundBearerSecretNames.join(', ')}; set ${unboundBearerSecretNames[0]}${BOUND_DOMAIN_SUFFIX}=<exact-host> before unbound bearer injection is removed`,
    );
  }

  const safeSyncFix =
    integrityHasMissing && !integrityHasModified && !integrityHasSourceGap
      ? {
          summary: 'Restore missing runtime instruction copies',
          apply: async () => {
            syncRuntimeInstructionCopies();
          },
        }
      : undefined;

  return [
    makeResult(
      'security',
      'Security',
      severity,
      messageParts.join(', '),
      safeSyncFix,
    ),
  ];
}
