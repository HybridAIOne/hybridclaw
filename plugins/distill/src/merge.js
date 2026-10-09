import fs from 'node:fs';
import path from 'node:path';
import {
  resolveInstallPath,
  syncRuntimeAssetRevisionState,
} from '@hybridaione/hybridclaw/plugin-sdk';

import { emitDistillAuditEvent } from './audit.js';

import { readJsonFile, sha256Hex, writeJsonFile } from './paths.js';
import {
  DISTILL_GENERATED_NOTE,
  renderCvFile,
  renderIdentityFile,
  renderMemoryFile,
  renderSoulFile,
  renderUserFile,
  renderWorkModule,
} from './render.js';
import { loadDistillState, makeClaimId, saveDistillState } from './state.js';

/**
 * F4-versioned write: the file content lands on disk and is immediately
 * snapshotted into the runtime revision database, so every merge is a
 * reversible edit (`hybridclaw config revisions` surfaces the history).
 */
export function writeVersionedDistillFile(filePath, content, assetType, runId) {
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
  paths,
  profile,
  validation,
  analysedDocIds,
  runId,
) {
  const state = loadDistillState(paths);
  const standingById = new Map(state.claims.map((claim) => [claim.id, claim]));
  const now = new Date().toISOString();
  const reviews = [];
  let claimsAdded = 0;

  for (const incoming of validation.validClaims) {
    const id = makeClaimId(incoming);
    if (standingById.has(id)) continue;
    const conflictTarget = incoming.conflictsWith
      ? standingById.get(incoming.conflictsWith)
      : undefined;
    if (conflictTarget && conflictTarget.status === 'standing') {
      const review = {
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
    const claim = {
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

  const workModule = renderWorkModule(
    profile,
    validation.extraction,
    `0.${state.mergeHistory.length}.0`,
  );
  state.skillName = workModule.skillName;
  const filesWritten = renderPersonaFiles(paths, profile, state, runId, {
    extraction: validation.extraction,
  });
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

const EMPTY_WORK_MODULE = {
  skillName: '',
  description: '',
  scope: [],
  workflows: [],
  outputPreferences: [],
  knowHow: [],
  workedExamples: [],
};

function buildExtractionShape(paths, profile, state, runId, extraction) {
  if (extraction) return { ...extraction, runId };
  return {
    version: 1,
    subject: paths.subject,
    runId,
    identity: state.identity || {
      name: profile.displayName,
      creature: '',
      vibe: '',
      emoji: '',
    },
    claims: [],
    workModule: {
      ...EMPTY_WORK_MODULE,
      skillName: state.skillName || '',
    },
    userNotes: state.userNotes || [],
    openQuestions: [],
  };
}

function normalizeTemplateComparison(content) {
  return content.replace(/\r\n/g, '\n').trim();
}

function isDefaultMemoryTemplate(content) {
  try {
    const template = fs.readFileSync(
      resolveInstallPath('templates', 'MEMORY.md'),
      'utf-8',
    );
    return (
      normalizeTemplateComparison(content) ===
      normalizeTemplateComparison(template)
    );
  } catch {
    return false;
  }
}

function shouldWriteDistilledMemory(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf-8');
    return (
      !existing.trim() ||
      existing.includes(DISTILL_GENERATED_NOTE) ||
      isDefaultMemoryTemplate(existing)
    );
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

export function ensureDistilledMemoryFile(paths, profile, runId = 'register') {
  const state = loadDistillState(paths);
  if (
    state.mergeHistory.length === 0 &&
    state.claims.length === 0 &&
    !state.identity &&
    (state.userNotes || []).length === 0
  ) {
    return null;
  }
  const memoryPath = path.join(paths.workspaceDir, 'MEMORY.md');
  if (!shouldWriteDistilledMemory(memoryPath)) return null;
  const extractionShape = buildExtractionShape(paths, profile, state, runId);
  writeVersionedDistillFile(
    memoryPath,
    renderMemoryFile(profile, state.claims, extractionShape, state.skillName),
    'template',
    runId,
  );
  return memoryPath;
}

function renderPersonaFiles(paths, profile, state, runId, options = {}) {
  const extractionShape = buildExtractionShape(
    paths,
    profile,
    state,
    runId,
    options.extraction,
  );
  const targets = [
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
      file: path.join(paths.workspaceDir, 'MEMORY.md'),
      content: renderMemoryFile(
        profile,
        state.claims,
        extractionShape,
        state.skillName,
      ),
      asset: 'template',
    },
    {
      file: path.join(paths.workspaceDir, 'CV.md'),
      content: renderCvFile(profile, state.claims),
      asset: 'cv',
    },
  ];
  const written = [];
  for (const target of targets) {
    if (
      path.basename(target.file) === 'MEMORY.md' &&
      !shouldWriteDistilledMemory(target.file)
    ) {
      continue;
    }
    writeVersionedDistillFile(target.file, target.content, target.asset, runId);
    written.push(target.file);
  }
  return written;
}

export function listReviewItems(paths) {
  let entries;
  try {
    entries = fs.readdirSync(paths.reviewsDir);
  } catch {
    return [];
  }
  const reviews = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const review = readJsonFile(path.join(paths.reviewsDir, entry));
    if (review) reviews.push(review);
  }
  return reviews.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

/**
 * The operator decides; the decision is recorded (review file + audit event)
 * and the persona files are re-rendered from the updated standing set.
 */
export function resolveReviewItem(
  paths,
  profile,
  reviewId,
  resolution,
  resolvedBy,
) {
  const reviewPath = path.join(paths.reviewsDir, `${reviewId}.json`);
  const review = readJsonFile(reviewPath);
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
  const incoming = {
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
