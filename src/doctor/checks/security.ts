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
import type { DiagResult } from '../types.js';
import { makeResult, severityFrom } from '../utils.js';

function checkWritablePath(targetPath: string): boolean {
  const existing = (() => {
    let current = path.resolve(targetPath);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return targetPath;
      current = parent;
    }
    return current;
  })();

  try {
    fs.accessSync(existing, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkSecurity(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const trustAccepted = isSecurityTrustAccepted(config);
  const instructionIntegrity = verifyInstructionIntegrity();
  const auditDir = path.join(DATA_DIR, 'audit');
  const auditWritable = checkWritablePath(auditDir);

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
