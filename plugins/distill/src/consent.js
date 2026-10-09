import fs from 'node:fs';
import { emitDistillAuditEvent } from './audit.js';

import { readJsonFile, sha256Hex, writeJsonFile } from './paths.js';

import { DistillBlockedError } from './types.js';

export function loadConsentArtefact(paths) {
  return readJsonFile(paths.consentPath);
}

export function hasValidConsent(paths) {
  const consent = loadConsentArtefact(paths);
  if (!consent || consent.revokedAt) return false;
  const expected = consentDigest(consent);
  return consent.sha256 === expected;
}

export function recordConsentArtefact(paths, input) {
  const grantedBy = input.grantedBy.trim();
  const statement = input.statement.trim();
  const method = input.method.trim();
  if (!grantedBy || !statement || !method) {
    throw new Error(
      'Consent requires --granted-by, --method, and --statement values.',
    );
  }
  const artefact = {
    version: 1,
    subject: paths.subject,
    subjectName: input.subjectName.trim() || paths.subject,
    grantedBy,
    method,
    scope:
      input.scope?.trim() ||
      'Distill persona and working knowledge into a HybridClaw coworker agent.',
    statement,
    note: input.note?.trim() || undefined,
    recordedAt: new Date().toISOString(),
    sha256: '',
  };
  artefact.sha256 = consentDigest(artefact);
  fs.mkdirSync(paths.subjectDir, { recursive: true });
  writeJsonFile(paths.consentPath, artefact);
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: 'consent',
    type: 'distill.consent.recorded',
    fields: {
      grantedBy: artefact.grantedBy,
      method: artefact.method,
      scope: artefact.scope,
      sha256: artefact.sha256,
    },
  });
  return artefact;
}

export function revokeConsentArtefact(paths) {
  const consent = loadConsentArtefact(paths);
  if (!consent) {
    throw new Error(`No consent artefact recorded for \`${paths.subject}\`.`);
  }
  if (!consent.revokedAt) {
    consent.revokedAt = new Date().toISOString();
    writeJsonFile(paths.consentPath, consent);
  }
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: 'consent',
    type: 'distill.consent.revoked',
    fields: { revokedAt: consent.revokedAt },
  });
  return consent;
}

/**
 * Hard trust gate (Principle VII): a run that distills a real, named human is
 * blocked until a recorded consent artefact exists. The block itself is
 * audited so refusals are as traceable as approvals.
 */
export function assertDistillConsent(paths, profile, runId) {
  if (!profile.realPerson) return;
  if (hasValidConsent(paths)) return;
  const consent = loadConsentArtefact(paths);
  const reason = !consent
    ? 'no consent artefact recorded'
    : consent.revokedAt
      ? 'consent artefact was revoked'
      : 'consent artefact failed integrity check';
  emitDistillAuditEvent({
    subject: paths.subject,
    runId,
    type: 'distill.run.blocked',
    fields: { reason },
  });
  throw new DistillBlockedError(
    `Distillation of \`${profile.displayName}\` is blocked: ${reason}.`,
    [
      `Record the subject's consent first:`,
      `  hybridclaw coworker consent record --alias ${paths.subject} \\`,
      `    --granted-by "<who granted it>" --method <written|verbal|email> \\`,
      `    --statement "<the consent statement as given>"`,
      `If the subject is fictional or a pseudonymous composite, re-run with --fictional.`,
    ].join('\n'),
  );
}

export function consentDigest(artefact) {
  return sha256Hex(
    [
      artefact.subject,
      artefact.subjectName,
      artefact.grantedBy,
      artefact.method,
      artefact.scope,
      artefact.statement,
      artefact.recordedAt,
    ].join('\n'),
  );
}
