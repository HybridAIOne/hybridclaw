import fs from 'node:fs';
import path from 'node:path';
import { scanForLeaks } from '../security/confidential-redact.js';
import { emitDistillAuditEvent } from './audit.js';
import { listCorpusDocuments } from './corpus.js';
import { loadDistillConfidentialRules } from './masking.js';
import type { DistillPaths } from './paths.js';
import { sha256Hex, writeJsonFile } from './paths.js';
import { loadDistillState } from './state.js';
import type { CorpusDocument, SubjectProfile } from './types.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CITATION_RE = /<!--\s*((?:doc_[0-9a-f]+\s*)+)-->/g;

/**
 * Deterministic holdout split (R72.9): a stable hash of the provenance id
 * decides membership, so re-ingesting the same material always reserves the
 * same slice for eval and never feeds it to analysis.
 */
export function markHoldoutDocuments(
  documents: CorpusDocument[],
  ratio: number,
): CorpusDocument[] {
  const percent = Math.round(Math.min(0.5, Math.max(0, ratio)) * 100);
  if (percent === 0) return documents;
  return documents.map((doc) => {
    const bucket = Number.parseInt(sha256Hex(doc.id).slice(0, 8), 16) % 100;
    return bucket < percent ? { ...doc, holdout: true } : doc;
  });
}

export interface LeakageFinding {
  file: string;
  kind: 'third-party-email' | 'uncited-source' | 'confidential-rule';
  detail: string;
}

export interface DistillEvalResult {
  subject: string;
  ranAt: string;
  leakage: {
    findings: LeakageFinding[];
    passed: boolean;
  };
  fidelity: {
    holdoutDocuments: number;
    promptsPrepared: number;
  };
}

/**
 * Leakage test: generated outputs must not contain third-party PII, must not
 * cite documents that do not exist in the corpus, and must not trip
 * operator-defined confidential rules. Any finding fails the eval.
 */
export function runLeakageScan(
  paths: DistillPaths,
  profile: SubjectProfile,
): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  const corpusIds = new Set(listCorpusDocuments(paths).map((doc) => doc.id));
  const subjectAliases = profile.matchAliases.map((alias) =>
    alias.toLowerCase(),
  );
  const ruleSet = loadDistillConfidentialRules();
  const state = loadDistillState(paths);
  const targets = [
    path.join(paths.workspaceDir, 'IDENTITY.md'),
    path.join(paths.workspaceDir, 'SOUL.md'),
    path.join(paths.workspaceDir, 'USER.md'),
    path.join(paths.workspaceDir, 'MEMORY.md'),
    path.join(paths.workspaceDir, 'CV.md'),
  ];
  if (state.skillName) {
    const skillDir = path.join(paths.workspaceDir, 'skills', state.skillName);
    targets.push(
      path.join(skillDir, 'SKILL.md'),
      path.join(skillDir, 'references', 'know-how.md'),
      path.join(skillDir, 'references', 'worked-examples.md'),
    );
  }
  for (const target of targets) {
    let content: string;
    try {
      content = fs.readFileSync(target, 'utf-8');
    } catch {
      continue;
    }
    const relative = path.relative(paths.workspaceDir, target);
    for (const email of content.match(EMAIL_RE) || []) {
      const lower = email.toLowerCase();
      const isSubject = subjectAliases.some(
        (alias) =>
          alias === lower ||
          alias === lower.split('@')[0] ||
          alias.includes(lower),
      );
      if (!isSubject) {
        findings.push({
          file: relative,
          kind: 'third-party-email',
          detail: `unmasked third-party email: ${email}`,
        });
      }
    }
    for (const match of content.matchAll(CITATION_RE)) {
      for (const docId of match[1].trim().split(/\s+/)) {
        if (!corpusIds.has(docId)) {
          findings.push({
            file: relative,
            kind: 'uncited-source',
            detail: `cites unknown corpus document: ${docId}`,
          });
        }
      }
    }
    if (ruleSet) {
      const scan = scanForLeaks(content, ruleSet);
      for (const finding of scan.findings) {
        findings.push({
          file: relative,
          kind: 'confidential-rule',
          detail: `confidential rule ${finding.ruleId} (${finding.sensitivity}) matched ${finding.matches}×`,
        });
      }
    }
  }
  return findings;
}

export interface FidelityPrompt {
  docId: string;
  source: string;
  title?: string;
  /** Context shown to the coworker; the held-out original is the reference answer. */
  prompt: string;
  reference: string;
}

/**
 * Fidelity eval plan: held-out subject-authored documents become
 * prompt/reference pairs. The coworker answers the prompt cold; a grader
 * (operator or agent) compares decisions + voice against the reference.
 */
export function buildFidelityPrompts(
  paths: DistillPaths,
  limit = 10,
): FidelityPrompt[] {
  const holdouts = listCorpusDocuments(paths)
    .filter((doc) => doc.holdout && doc.authoredBySubject)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  return holdouts.map((doc) => ({
    docId: doc.id,
    source: doc.source,
    title: doc.title,
    prompt: `Respond as you would in this situation${doc.title ? ` (${doc.title})` : ''}: ${doc.content.slice(0, 280)}…`,
    reference: doc.content,
  }));
}

export function runDistillEval(
  paths: DistillPaths,
  profile: SubjectProfile,
  evalPath: string,
): DistillEvalResult {
  const findings = runLeakageScan(paths, profile);
  const prompts = buildFidelityPrompts(paths);
  const holdoutDocuments = listCorpusDocuments(paths).filter(
    (doc) => doc.holdout,
  ).length;
  const result: DistillEvalResult = {
    subject: paths.subject,
    ranAt: new Date().toISOString(),
    leakage: { findings, passed: findings.length === 0 },
    fidelity: {
      holdoutDocuments,
      promptsPrepared: prompts.length,
    },
  };
  writeJsonFile(evalPath, { ...result, fidelityPrompts: prompts });
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: 'eval',
    type: 'distill.eval.completed',
    fields: {
      leakageFindings: findings.length,
      leakagePassed: result.leakage.passed,
      fidelityPrompts: prompts.length,
    },
  });
  return result;
}
