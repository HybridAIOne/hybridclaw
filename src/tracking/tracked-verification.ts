/**
 * Acceptance checks on the existing tracked job. Only gateway observations pass a
 * check; model claims cannot. Verification never grants permission or completes
 * an outcome, and changed evidence invalidates a previous pass.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Receipt } from '../gateway/receipts-command.js';
import { readSystemFile } from '../gateway/system-files.js';
import { isRealScopeDir, sessionWorkspaceDir } from '../scopes/scope-paths.js';
import type { Session } from '../types/session.js';
import { stableStringify } from '../utils/stable-json.js';
import { isRecord } from '../utils/type-guards.js';
import type { TrackReference } from './follow-through-types.js';
import { listTracked, TrackError, type Tracked } from './track-store.js';

export type AcceptanceCheck = { id: string; title: string } & (
  | {
      kind: 'artifact';
      path: string;
      format: 'file' | 'text' | 'json';
      required: string[];
    }
  | { kind: 'receipt'; reference: Extract<TrackReference, { kind: 'receipt' }> }
);
export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  reason: string;
  fingerprint: string;
}
export interface VerificationAttempt {
  at: string;
  fingerprint: string;
  checks: CheckResult[];
}
export interface JobContract {
  objective: string;
  attemptLimit: number;
  checks: AcceptanceCheck[];
  dependencies: number[];
  attempts: VerificationAttempt[];
}
export type ReceiptReader = (reference: TrackReference) => {
  receipt?: Receipt;
};

// Engineering bounds (2026-10-28): one initial verification and two repairs;
// inspect at most twenty 1 MiB artifacts. Larger or semantic checks need review.
export const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_CHECK_BYTES = 1024 * 1024;
const digest = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new TrackError('Acceptance checks need bounded, non-empty text.');
  return value.trim();
}

export function jobContract(raw: unknown, dependencies: unknown): JobContract {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20)
    throw new TrackError('Define between one and twenty acceptance checks.');
  const checks = raw.map((entry): AcceptanceCheck => {
    if (!isRecord(entry)) throw new TrackError('Invalid acceptance check.');
    const base = { id: text(entry.id, 100), title: text(entry.title, 200) };
    if (entry.kind === 'receipt') {
      const ref = entry.reference;
      if (!isRecord(ref) || ref.kind !== 'receipt')
        throw new TrackError('Expected a receipt reference.');
      return {
        ...base,
        kind: 'receipt',
        reference: {
          kind: 'receipt',
          session_id: text(ref.session_id, 200),
          receipt_id: text(ref.receipt_id, 200),
        },
      };
    }
    if (
      entry.kind !== 'artifact' ||
      !['file', 'text', 'json'].includes(String(entry.format))
    )
      throw new TrackError('Expected an artifact or receipt check.');
    const file = text(entry.path, 2000);
    if (
      path.isAbsolute(file) ||
      file.split(/[\\/]/).some((part) => part === '..')
    )
      throw new TrackError('Checks must stay inside the current workspace.');
    const required = entry.required ?? [];
    if (
      !Array.isArray(required) ||
      required.length > 20 ||
      (entry.format !== 'file' && !required.length)
    )
      throw new TrackError(
        'Text and JSON checks need one to twenty required values.',
      );
    return {
      ...base,
      kind: 'artifact',
      path: file,
      format: entry.format as 'file' | 'text' | 'json',
      required: required.map((value) => text(value, 1000)),
    };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length)
    throw new TrackError('Acceptance check ids must be unique.');
  const ids = dependencies ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 20 ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  )
    throw new TrackError('Invalid job dependencies.');
  return {
    objective: '',
    attemptLimit: MAX_VERIFICATION_ATTEMPTS,
    checks,
    dependencies: ids,
    attempts: [],
  };
}

export function assertDependencies(
  session: Session,
  item: Tracked,
  contract: JobContract,
): void {
  const all = new Map(listTracked(session).map((entry) => [entry.id, entry]));
  const visited = new Set<number>();
  function visit(id: number, seen: Set<number>): void {
    if (id === item.id || seen.has(id))
      throw new TrackError('Job dependencies must not form a cycle.');
    if (visited.has(id)) return;
    const dependency = all.get(id);
    if (!dependency) throw new TrackError('A dependency is not accessible.');
    for (const next of dependency.followThrough?.job?.dependencies ?? [])
      visit(next, new Set([...seen, id]));
    visited.add(id);
  }
  for (const id of contract.dependencies) visit(id, new Set());
}

export function observeChecks(
  session: Session,
  contract: JobContract,
  read: ReceiptReader,
): CheckResult[] {
  return contract.checks.map((check) => {
    const result = (
      passed: boolean,
      reason: string,
      evidence: unknown,
    ): CheckResult => ({
      id: check.id,
      title: check.title,
      passed,
      reason,
      fingerprint: digest({ check, evidence }),
    });
    if (check.kind === 'receipt') {
      try {
        const receipt = read(check.reference).receipt;
        return result(
          receipt?.ok === true && receipt.proof?.status === 'confirmed',
          receipt?.ok && receipt.proof?.status === 'confirmed'
            ? 'Action confirmed.'
            : 'Action is not confirmed.',
          receipt ?? null,
        );
      } catch {
        return result(false, 'Receipt unavailable.', null);
      }
    }
    const root = sessionWorkspaceDir(session);
    if (session.scope && !isRealScopeDir(session.agent_id, session.scope))
      return result(false, 'File unavailable in this workspace.', null);
    try {
      const bytes = readSystemFile(root, check.path, MAX_CHECK_BYTES);
      if (!bytes.length) return result(false, 'File is empty.', null);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (check.format === 'file')
        return result(true, 'File exists and is not empty.', hash);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (check.format === 'text') {
        const passed = check.required.every((value) => content.includes(value));
        return result(
          passed,
          passed ? 'Required text found.' : 'Required text is missing.',
          hash,
        );
      }
      try {
        const json: unknown = JSON.parse(content);
        const passed =
          isRecord(json) &&
          check.required.every(
            (key) => Object.hasOwn(json, key) && json[key] != null,
          );
        return result(
          passed,
          passed
            ? 'Required JSON fields found.'
            : 'Required JSON fields are missing.',
          hash,
        );
      } catch {
        return result(false, 'File is not valid JSON.', hash);
      }
    } catch {
      return result(false, 'File could not be checked.', null);
    }
  });
}

export function verifyJob(
  session: Session,
  contract: JobContract,
  read: ReceiptReader,
  now: Date,
): void {
  const checks = observeChecks(session, contract, read);
  const fingerprint = digest({ objective: contract.objective, checks });
  if (contract.attempts.at(-1)?.fingerprint === fingerprint)
    throw new TrackError(
      'No evidence changed. Repair the failed checks before verifying again.',
    );
  if (contract.attempts.length >= contract.attemptLimit)
    throw new TrackError(
      'Verification limit reached. Ask the user to review the remaining gaps.',
    );
  contract.attempts.push({ at: now.toISOString(), fingerprint, checks });
}

export function jobView(session: Session, item: Tracked, read: ReceiptReader) {
  const contract = item.followThrough?.job;
  if (!contract) return null;
  const checks = observeChecks(session, contract, read);
  const last = contract.attempts.at(-1);
  const fresh =
    contract.objective === (item.outcome ?? item.title) &&
    last?.fingerprint === digest({ objective: contract.objective, checks });
  const passed = fresh && checks.every((check) => check.passed);
  const all = listTracked(session);
  const dependencies = contract.dependencies.map((id) => {
    const dependency = all.find((entry) => entry.id === id);
    return {
      id,
      title: dependency?.title ?? null,
      completed: Boolean(dependency?.done),
    };
  });
  const ready = passed && dependencies.every((entry) => entry.completed);
  const remaining = Math.max(
    0,
    contract.attemptLimit - contract.attempts.length,
  );
  return {
    id: item.id,
    owner: session.agent_id,
    outcome: item.outcome,
    criteria: contract.checks,
    checks,
    attempts: contract.attempts,
    attempts_remaining: remaining,
    verified_at: fresh ? (last?.at ?? null) : null,
    ready: Boolean(ready),
    dependencies,
    next_gate: item.done
      ? 'completed'
      : ready
        ? 'review'
        : dependencies.some((entry) => !entry.completed)
          ? 'dependencies'
          : remaining === 0
            ? 'needs_attention'
            : !last
              ? 'prepare'
              : 'repair',
    next_step: item.steps.find((step) => !step.done)?.title ?? null,
  };
}
