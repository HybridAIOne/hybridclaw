import fs from 'node:fs';
import { emitDistillAuditEvent } from './audit.js';
import {
  appendCorpusDocuments,
  computeCorpusDocumentId,
  countWords,
} from './corpus.js';
import { maskThirdPartyPii } from './masking.js';
import type { DistillPaths } from './paths.js';
import { sha256Hex } from './paths.js';
import { loadDistillState } from './state.js';
import type { CorrectionRecord, SubjectProfile } from './types.js';

/**
 * Conversational correction layer (R72.6): an operator nudge ("she'd never
 * open with a greeting") becomes a maximum-weight corpus document, so the
 * next analyse → merge cycle promotes it into the persona/work files as a
 * `correction`-dimension claim that overrides conflicting inferences.
 */
export function recordCorrection(
  paths: DistillPaths,
  profile: SubjectProfile,
  input: {
    text: string;
    scope?: 'persona' | 'work' | 'both';
    recordedBy: string;
  },
): CorrectionRecord {
  const text = input.text.trim();
  if (!text) {
    throw new Error('A correction needs text. Use --note "<correction>".');
  }
  const recordedAt = new Date().toISOString();
  const masked = maskThirdPartyPii(text, profile.matchAliases);
  const content = `Operator correction for ${profile.displayName}: ${masked.text}`;
  const origin = `correction:${recordedAt}`;
  const docId = computeCorpusDocumentId(content, origin);
  appendCorpusDocuments(
    paths,
    [
      {
        id: docId,
        subject: paths.subject,
        source: 'correction',
        origin,
        author: input.recordedBy,
        authoredBySubject: false,
        content,
        wordCount: countWords(content),
        weight: 1,
        maskedThirdParties: masked.maskedCount,
        ingestedAt: recordedAt,
      },
    ],
    'correction',
  );
  const record: CorrectionRecord = {
    id: `cor_${sha256Hex(`${recordedAt}\n${text}`).slice(0, 12)}`,
    subject: paths.subject,
    text: masked.text,
    scope: input.scope || 'both',
    recordedBy: input.recordedBy,
    recordedAt,
    docId,
  };
  fs.mkdirSync(paths.subjectDir, { recursive: true });
  fs.appendFileSync(
    paths.correctionsPath,
    `${JSON.stringify(record)}\n`,
    'utf-8',
  );
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: 'correction',
    type: 'distill.correction.recorded',
    fields: { correctionId: record.id, docId, scope: record.scope },
  });
  return record;
}

export function listCorrections(paths: DistillPaths): CorrectionRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.correctionsPath, 'utf-8');
  } catch {
    return [];
  }
  const records: CorrectionRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CorrectionRecord);
    } catch {
      // Skip torn lines.
    }
  }
  return records;
}

export function pendingCorrections(paths: DistillPaths): CorrectionRecord[] {
  const analysed = new Set(loadDistillState(paths).analysedDocIds);
  return listCorrections(paths).filter((record) => !analysed.has(record.docId));
}
