import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeRevisionAssetType } from '../config/runtime-config-revisions.js';
import { syncRuntimeAssetRevisionState } from '../config/runtime-config-revisions.js';
import type { ExtractionValidationResult } from './analysis.js';
import { emitDistillAuditEvent } from './audit.js';
import type { DistillPaths } from './paths.js';
import { readJsonFile, sha256Hex, writeJsonFile } from './paths.js';
import {
  renderCvFile,
  renderIdentityFile,
  renderSoulFile,
  renderUserFile,
  renderWorkModule,
} from './render.js';
import { loadDistillState, makeClaimId, saveDistillState } from './state.js';
import type {
  DistillReviewItem,
  DistillState,
  PersonaClaim,
  SubjectProfile,
} from './types.js';

export interface MergeResult {
  claimsAdded: number;
  claimsSuperseded: number;
  reviewsOpened: number;
  filesWritten: string[];
  reviews: DistillReviewItem[];
}

/**
 * F4-versioned write: the file content lands on disk and is immediately
 * snapshotted into the runtime revision database, so every merge is a
 * reversible edit (`hybridclaw config revisions` surfaces the history).
 */
export function writeVersionedDistillFile(
  filePath: string,
  content: string,
  assetType: RuntimeRevisionAssetType,
  runId: string,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  syncRuntimeAssetRevisionState(assetType, filePath, {
    actor: 'distill',
    route: 'cli',
    source: runId,
  });
}

/**
 * Merge semantics (R72.5): append-and-re-analyse. New claims join the
 * standing set; duplicates are skipped; declared conflicts open review items
 * for the operator instead of silently averaging; nothing standing is ever
 * overwritten without a recorded decision.
 */
export function applyDistillMerge(
  paths: DistillPaths,
  profile: SubjectProfile,
  validation: ExtractionValidationResult,
  analysedDocIds: string[],
  runId: string,
): MergeResult {
  const state = loadDistillState(paths);
  const standingById = new Map(
    state.claims.map((claim) => [claim.id, claim] as const),
  );
  const now = new Date().toISOString();
  const reviews: DistillReviewItem[] = [];
  let claimsAdded = 0;

  for (const incoming of validation.validClaims) {
    const id = makeClaimId(incoming);
    if (standingById.has(id)) continue;
    const conflictTarget = incoming.conflictsWith
      ? standingById.get(incoming.conflictsWith)
      : undefined;
    if (conflictTarget && conflictTarget.status === 'standing') {
      const review: DistillReviewItem = {
        id: `rev_${sha256Hex(`${conflictTarget.id}\n${incoming.claim}`).slice(0, 12)}`,
        subject: paths.subject,
        openedAt: now,
        runId,
        dimension: incoming.dimension,
        standingClaimId: conflictTarget.id,
        standingClaim: conflictTarget.claim,
        incomingClaim: incoming.claim,
        incomingEvidence: incoming.evidence,
        status: 'open',
      };
      reviews.push(review);
      writeJsonFile(path.join(paths.reviewsDir, `${review.id}.json`), review);
      emitDistillAuditEvent({
        subject: paths.subject,
        runId,
        type: 'distill.review.opened',
        fields: {
          reviewId: review.id,
          standingClaimId: conflictTarget.id,
          incomingClaim: incoming.claim,
        },
      });
      continue;
    }
    const claim: PersonaClaim = {
      ...incoming,
      id,
      status: 'standing',
      firstSeenRunId: runId,
      updatedAt: now,
    };
    state.claims.push(claim);
    standingById.set(id, claim);
    claimsAdded += 1;
    emitDistillAuditEvent({
      subject: paths.subject,
      runId,
      type: 'distill.claim.merged',
      fields: {
        claimId: id,
        dimension: claim.dimension,
        evidence: claim.evidence,
        confidence: claim.confidence,
      },
    });
  }

  const analysed = new Set(state.analysedDocIds);
  for (const docId of analysedDocIds) analysed.add(docId);
  state.analysedDocIds = [...analysed];
  state.identity = validation.extraction.identity;
  state.userNotes = validation.extraction.userNotes || [];
  state.mergeHistory.push({
    runId,
    mergedAt: now,
    claimsAdded,
    claimsSuperseded: 0,
    reviewsOpened: reviews.length,
  });

  const filesWritten = renderPersonaFiles(paths, profile, state, runId);
  const workModule = renderWorkModule(
    profile,
    validation.extraction,
    `0.${state.mergeHistory.length}.0`,
  );
  state.skillName = workModule.skillName;
  const skillDir = path.join(
    paths.workspaceDir,
    'skills',
    workModule.skillName,
  );
  for (const [relPath, content] of Object.entries(workModule.files)) {
    const filePath = path.join(skillDir, relPath);
    writeVersionedDistillFile(filePath, content, 'skill', runId);
    filesWritten.push(filePath);
  }
  saveDistillState(paths, state);

  emitDistillAuditEvent({
    subject: paths.subject,
    runId,
    type: 'distill.merge.applied',
    fields: {
      claimsAdded,
      reviewsOpened: reviews.length,
      filesWritten: filesWritten.map((file) =>
        path.relative(paths.workspaceDir, file),
      ),
    },
  });

  return {
    claimsAdded,
    claimsSuperseded: 0,
    reviewsOpened: reviews.length,
    filesWritten,
    reviews,
  };
}

function renderPersonaFiles(
  paths: DistillPaths,
  profile: SubjectProfile,
  state: DistillState,
  runId: string,
): string[] {
  const identity = state.identity || {
    name: profile.displayName,
    creature: '',
    vibe: '',
    emoji: '',
  };
  const extractionShape = {
    version: 1 as const,
    subject: paths.subject,
    runId,
    identity,
    claims: [],
    workModule: {
      skillName: state.skillName || '',
      description: '',
      scope: [],
      workflows: [],
      outputPreferences: [],
      knowHow: [],
      workedExamples: [],
    },
    userNotes: state.userNotes || [],
    openQuestions: [],
  };
  const targets: {
    file: string;
    content: string;
    asset: RuntimeRevisionAssetType;
  }[] = [
    {
      file: path.join(paths.workspaceDir, 'IDENTITY.md'),
      content: renderIdentityFile(profile, extractionShape),
      asset: 'template',
    },
    {
      file: path.join(paths.workspaceDir, 'SOUL.md'),
      content: renderSoulFile(profile, state.claims),
      asset: 'template',
    },
    {
      file: path.join(paths.workspaceDir, 'USER.md'),
      content: renderUserFile(profile, extractionShape),
      asset: 'template',
    },
    {
      file: path.join(paths.workspaceDir, 'CV.md'),
      content: renderCvFile(profile, state.claims),
      asset: 'cv',
    },
  ];
  const written: string[] = [];
  for (const target of targets) {
    writeVersionedDistillFile(target.file, target.content, target.asset, runId);
    written.push(target.file);
  }
  return written;
}

export function listReviewItems(paths: DistillPaths): DistillReviewItem[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.reviewsDir);
  } catch {
    return [];
  }
  const reviews: DistillReviewItem[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const review = readJsonFile<DistillReviewItem>(
      path.join(paths.reviewsDir, entry),
    );
    if (review) reviews.push(review);
  }
  return reviews.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

/**
 * The operator decides; the decision is recorded (review file + audit event)
 * and the persona files are re-rendered from the updated standing set.
 */
export function resolveReviewItem(
  paths: DistillPaths,
  profile: SubjectProfile,
  reviewId: string,
  resolution: 'keep-standing' | 'accept-incoming' | 'keep-both',
  resolvedBy: string,
): DistillReviewItem {
  const reviewPath = path.join(paths.reviewsDir, `${reviewId}.json`);
  const review = readJsonFile<DistillReviewItem>(reviewPath);
  if (!review) {
    throw new Error(`Review item not found: ${reviewId}`);
  }
  if (review.status === 'resolved') {
    throw new Error(`Review ${reviewId} is already resolved.`);
  }
  const state = loadDistillState(paths);
  const now = new Date().toISOString();
  const standing = state.claims.find(
    (claim) => claim.id === review.standingClaimId,
  );
  const incoming: PersonaClaim = {
    dimension: review.dimension,
    claim: review.incomingClaim,
    evidence: review.incomingEvidence,
    confidence: 0.8,
    id: makeClaimId({
      dimension: review.dimension,
      claim: review.incomingClaim,
      evidence: review.incomingEvidence,
      confidence: 0.8,
    }),
    status: 'standing',
    firstSeenRunId: review.runId,
    updatedAt: now,
  };
  let claimsSuperseded = 0;
  if (resolution === 'accept-incoming') {
    if (standing) {
      standing.status = 'superseded';
      standing.updatedAt = now;
      claimsSuperseded = 1;
    }
    state.claims.push(incoming);
  } else if (resolution === 'keep-both') {
    state.claims.push(incoming);
  }
  review.status = 'resolved';
  review.resolution = resolution;
  review.resolvedAt = now;
  review.resolvedBy = resolvedBy;
  writeJsonFile(reviewPath, review);
  state.mergeHistory.push({
    runId: review.runId,
    mergedAt: now,
    claimsAdded: resolution === 'keep-standing' ? 0 : 1,
    claimsSuperseded,
    reviewsOpened: 0,
  });
  saveDistillState(paths, state);
  renderPersonaFiles(paths, profile, state, `${review.runId}:review`);
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: review.runId,
    type: 'distill.review.resolved',
    fields: { reviewId, resolution, resolvedBy },
  });
  return review;
}
