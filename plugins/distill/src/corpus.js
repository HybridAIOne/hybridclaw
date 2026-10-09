import fs from 'node:fs';
import { syncRuntimeAssetRevisionState } from '@hybridaione/hybridclaw/plugin-sdk';
import { emitDistillAuditEvent } from './audit.js';

import { sha256Hex } from './paths.js';

export function computeCorpusDocumentId(content, origin) {
  return `doc_${sha256Hex(`${origin}\n${content}`).slice(0, 12)}`;
}

export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic quality weighting (R72.2): authored long-form text ranks
 * above casual chatter, third-party material is context only, and operator
 * signals (interview answers, corrections) carry the highest weight.
 */
export function computeQualityWeight(params) {
  const base = {
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

export function listCorpusDocuments(paths) {
  let raw;
  try {
    raw = fs.readFileSync(paths.corpusDocumentsPath, 'utf-8');
  } catch {
    return [];
  }
  const documents = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      documents.push(JSON.parse(trimmed));
    } catch {
      // Skip a torn line rather than failing the whole corpus read.
    }
  }
  return documents;
}

export function getCorpusDocument(paths, docId) {
  return listCorpusDocuments(paths).find((doc) => doc.id === docId) || null;
}

export function removeCorpusDocument(paths, docId) {
  const documents = listCorpusDocuments(paths);
  const index = documents.findIndex((doc) => doc.id === docId);
  if (index < 0) return null;

  const [removed] = documents.splice(index, 1);
  if (!removed) return null;

  fs.mkdirSync(paths.corpusDir, { recursive: true });
  const lines = documents.map((doc) => JSON.stringify(doc)).join('\n');
  fs.writeFileSync(
    paths.corpusDocumentsPath,
    lines ? `${lines}\n` : '',
    'utf-8',
  );
  syncRuntimeAssetRevisionState('knowledge', paths.corpusDocumentsPath, {
    actor: 'distill',
    route: 'admin',
    source: removed.runId || 'manual-delete',
  });
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: removed.runId || 'manual-delete',
    type: 'distill.corpus.deleted',
    fields: {
      documentId: removed.id,
      origin: removed.origin,
    },
  });
  return removed;
}

/**
 * Append-only ingestion: existing documents are never rewritten, duplicates
 * (same provenance id) are skipped, and every append lands as an F4-versioned
 * `knowledge` asset revision so corpus growth is reversible.
 */
export function appendCorpusDocuments(paths, documents, runId) {
  const existingIds = new Set(listCorpusDocuments(paths).map((doc) => doc.id));
  const added = [];
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
