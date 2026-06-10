import fs from 'node:fs';
import { syncRuntimeAssetRevisionState } from '../config/runtime-config-revisions.js';
import { emitDistillAuditEvent } from './audit.js';
import type { DistillPaths } from './paths.js';
import { sha256Hex } from './paths.js';
import type { CorpusDocument, CorpusSourceKind } from './types.js';

export function computeCorpusDocumentId(
  content: string,
  origin: string,
): string {
  return `doc_${sha256Hex(`${origin}\n${content}`).slice(0, 12)}`;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic quality weighting (R72.2): authored long-form text ranks
 * above casual chatter, third-party material is context only, and operator
 * signals (interview answers, corrections) carry the highest weight.
 */
export function computeQualityWeight(params: {
  source: CorpusSourceKind;
  wordCount: number;
  authoredBySubject: boolean;
}): number {
  const base: Record<CorpusSourceKind, number> = {
    interview: 1.0,
    correction: 1.0,
    markdown: 0.9,
    text: 0.85,
    'email-mbox': 0.8,
    transcript: 0.55,
    'chat-jsonl': 0.4,
    'slack-export': 0.4,
  };
  const lengthFactor =
    params.wordCount >= 300 ? 1.0 : params.wordCount >= 50 ? 0.85 : 0.6;
  const authorshipFactor = params.authoredBySubject ? 1.0 : 0.25;
  const weight = base[params.source] * lengthFactor * authorshipFactor;
  return Math.min(1, Math.max(0.05, Number(weight.toFixed(3))));
}

export function listCorpusDocuments(paths: DistillPaths): CorpusDocument[] {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.corpusDocumentsPath, 'utf-8');
  } catch {
    return [];
  }
  const documents: CorpusDocument[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      documents.push(JSON.parse(trimmed) as CorpusDocument);
    } catch {
      // Skip a torn line rather than failing the whole corpus read.
    }
  }
  return documents;
}

export function getCorpusDocument(
  paths: DistillPaths,
  docId: string,
): CorpusDocument | null {
  return listCorpusDocuments(paths).find((doc) => doc.id === docId) || null;
}

/**
 * Append-only ingestion: existing documents are never rewritten, duplicates
 * (same provenance id) are skipped, and every append lands as an F4-versioned
 * `knowledge` asset revision so corpus growth is reversible.
 */
export function appendCorpusDocuments(
  paths: DistillPaths,
  documents: CorpusDocument[],
  runId: string,
): { added: CorpusDocument[]; skippedDuplicates: number } {
  const existingIds = new Set(listCorpusDocuments(paths).map((doc) => doc.id));
  const added: CorpusDocument[] = [];
  let skippedDuplicates = 0;
  for (const doc of documents) {
    if (existingIds.has(doc.id)) {
      skippedDuplicates += 1;
      continue;
    }
    existingIds.add(doc.id);
    added.push(doc);
  }
  if (added.length > 0) {
    fs.mkdirSync(paths.corpusDir, { recursive: true });
    const lines = added.map((doc) => JSON.stringify(doc)).join('\n');
    fs.appendFileSync(paths.corpusDocumentsPath, `${lines}\n`, 'utf-8');
    syncRuntimeAssetRevisionState('knowledge', paths.corpusDocumentsPath, {
      actor: 'distill',
      route: 'cli',
      source: runId,
    });
  }
  emitDistillAuditEvent({
    subject: paths.subject,
    runId,
    type: 'distill.corpus.appended',
    fields: {
      documentsAdded: added.length,
      skippedDuplicates,
      documentIds: added.map((doc) => doc.id),
    },
  });
  return { added, skippedDuplicates };
}
