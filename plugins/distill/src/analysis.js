import fs from 'node:fs';
import { listCorpusDocuments } from './corpus.js';

import { readJsonFile, writeJsonFile } from './paths.js';
import { loadDistillState } from './state.js';

import { PERSONA_DIMENSIONS } from './types.js';

export const DIMENSION_GUIDE = {
  identity:
    'Who they are at work: role, self-image, what they own, what they are known for.',
  expression:
    'Voice and style: tone, greetings and sign-offs, formatting habits, humour, pet phrases, what they would never say.',
  'decision-making':
    'How they decide: heuristics, trade-offs they accept, what they escalate, risk appetite, what evidence convinces them.',
  interpersonal:
    'How they work with others: directness, feedback style, meeting behaviour, who they defer to, how they push back.',
  experience:
    'What they have done and know: domains, systems, past projects, hard-won lessons.',
  correction:
    'Known corrections: behaviours the operator or subject has explicitly corrected; these override conflicting inferences.',
};

/**
 * The analyse stage is deterministic: it selects the corpus delta (documents
 * not yet analysed, holdouts excluded), orders it by quality weight, and
 * packages it with the standing conclusions so the analysing agent re-reads
 * only what is new. Model judgment happens against this packet and comes
 * back through `extraction.json`.
 */
export function buildAnalysisPacket(paths, runPaths, profile, runId) {
  const state = loadDistillState(paths);
  const analysed = new Set(state.analysedDocIds);
  const delta = listCorpusDocuments(paths)
    .filter((doc) => !doc.holdout && !analysed.has(doc.id))
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        (a.timestamp || '').localeCompare(b.timestamp || ''),
    );
  const standingClaims = state.claims
    .filter((claim) => claim.status === 'standing')
    .map((claim) => ({
      id: claim.id,
      dimension: claim.dimension,
      claim: claim.claim,
    }));
  const coverage = Object.fromEntries(
    PERSONA_DIMENSIONS.map((dimension) => [
      dimension,
      standingClaims.filter((claim) => claim.dimension === dimension).length,
    ]),
  );
  const packet = {
    version: 1,
    subject: paths.subject,
    runId,
    generatedAt: new Date().toISOString(),
    profile: {
      displayName: profile.displayName,
      role: profile.role,
      relationship: profile.relationship,
      personalityTags: profile.personalityTags,
    },
    standingClaims,
    dimensionCoverage: coverage,
    deltaDocuments: delta.map((doc) => ({
      id: doc.id,
      source: doc.source,
      origin: doc.origin,
      author: doc.author,
      authoredBySubject: doc.authoredBySubject,
      weight: doc.weight,
      title: doc.title,
      timestamp: doc.timestamp,
      content: doc.content,
    })),
  };
  fs.mkdirSync(runPaths.analysisDir, { recursive: true });
  writeJsonFile(runPaths.packetJsonPath, packet);
  fs.writeFileSync(
    runPaths.packetMarkdownPath,
    renderPacketMarkdown(packet),
    'utf-8',
  );
  return packet;
}

function renderPacketMarkdown(packet) {
  const lines = [
    `# Analysis Packet — ${packet.profile.displayName}`,
    '',
    `Run \`${packet.runId}\`. Read the delta documents below, then write`,
    `\`extraction.json\` next to this file following the extraction contract`,
    `(\`skills/human-distill/references/extraction-contract.md\`).`,
    '',
    '**Hard rule:** every claim must cite the ids of the documents it is',
    'drawn from. Claims without valid evidence are flagged and excluded —',
    'never invent beyond the corpus. If new evidence contradicts a standing',
    'claim, set `conflictsWith` to that claim id instead of restating it.',
    '',
    '## Dimension coverage so far',
    '',
  ];
  for (const dimension of PERSONA_DIMENSIONS) {
    lines.push(
      `- **${dimension}** (${packet.dimensionCoverage[dimension]} standing): ${DIMENSION_GUIDE[dimension]}`,
    );
  }
  if (packet.standingClaims.length > 0) {
    lines.push('', '## Standing claims (context — do not restate)', '');
    for (const claim of packet.standingClaims) {
      lines.push(`- \`${claim.id}\` [${claim.dimension}] ${claim.claim}`);
    }
  }
  lines.push('', `## Delta documents (${packet.deltaDocuments.length})`, '');
  for (const doc of packet.deltaDocuments) {
    lines.push(
      `### ${doc.id} — ${doc.title || doc.origin}`,
      '',
      `- source: ${doc.source} | author: ${doc.author}${doc.authoredBySubject ? ' (subject)' : ''} | weight: ${doc.weight}${doc.timestamp ? ` | ${doc.timestamp}` : ''}`,
      '',
      '```',
      doc.content,
      '```',
      '',
    );
  }
  return lines.join('\n');
}

/**
 * `extraction.json` is the single contract through which model judgment
 * enters the pipeline: written by the analysing agent, validated here, and
 * rendered deterministically into the identity files and work-module skill.
 */
export function loadExtraction(runPaths) {
  return readJsonFile(runPaths.extractionPath);
}

/**
 * Citation enforcement (R72.3): a claim survives only if every part of it is
 * structurally sound and at least one cited document actually exists in the
 * corpus (holdouts excluded — they are reserved for eval). Unsupported claims
 * are flagged for the report, not fabricated into the persona.
 */
export function validateExtraction(paths, extraction) {
  if (extraction.version !== 1) {
    throw new Error(
      `Unsupported extraction version: ${String(extraction.version)}`,
    );
  }
  if (extraction.subject !== paths.subject) {
    throw new Error(
      `Extraction subject \`${extraction.subject}\` does not match \`${paths.subject}\`.`,
    );
  }
  const corpusIds = new Set(
    listCorpusDocuments(paths)
      .filter((doc) => !doc.holdout)
      .map((doc) => doc.id),
  );
  const flagged = [];
  const checkEvidence = (label, evidence) => {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      flagged.push({ claim: label, reason: 'no evidence cited' });
      return false;
    }
    const known = evidence.filter(
      (id) => typeof id === 'string' && corpusIds.has(id),
    );
    if (known.length === 0) {
      flagged.push({
        claim: label,
        reason: `cited documents not found in corpus: ${evidence.join(', ')}`,
      });
      return false;
    }
    return true;
  };

  const validClaims = [];
  for (const claim of extraction.claims || []) {
    const text = String(claim?.claim || '').trim();
    if (!text) continue;
    if (!PERSONA_DIMENSIONS.includes(claim.dimension)) {
      flagged.push({
        claim: text,
        reason: `unknown dimension: ${String(claim.dimension)}`,
      });
      continue;
    }
    if (!checkEvidence(text, claim.evidence)) continue;
    validClaims.push({
      dimension: claim.dimension,
      claim: text,
      evidence: claim.evidence.filter((id) => corpusIds.has(id)),
      confidence: clampConfidence(claim.confidence),
      conflictsWith: claim.conflictsWith || undefined,
    });
  }

  const work = extraction.workModule;
  if (work) {
    work.workflows = (work.workflows || []).filter((workflow) =>
      checkEvidence(`workflow: ${workflow.title}`, workflow.evidence),
    );
    work.outputPreferences = (work.outputPreferences || []).filter(
      (preference) =>
        checkEvidence(
          `output preference: ${preference.claim}`,
          preference.evidence,
        ),
    );
    work.knowHow = (work.knowHow || []).filter((entry) =>
      checkEvidence(`know-how: ${entry.topic}`, entry.evidence),
    );
    work.workedExamples = (work.workedExamples || []).filter((example) =>
      checkEvidence(`worked example: ${example.title}`, example.evidence),
    );
  }

  return { extraction, validClaims, flagged };
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  return Math.min(1, Math.max(0, num));
}

export function summarizeDelta(documents) {
  const bySource = new Map();
  for (const doc of documents) {
    bySource.set(doc.source, (bySource.get(doc.source) || 0) + 1);
  }
  return (
    [...bySource.entries()]
      .map(([source, count]) => `${source}: ${count}`)
      .join(', ') || 'none'
  );
}
