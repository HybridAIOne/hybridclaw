import fs from 'node:fs';
import path from 'node:path';
import { emitDistillAuditEvent } from './audit.js';

import {
  makeDistillRunId,
  readJsonFile,
  resolveDistillRunPaths,
  writeJsonFile,
} from './paths.js';

import { DISTILL_STAGE_ORDER } from './types.js';

export function createDistillRun(paths, sources) {
  const runId = makeDistillRunId();
  const now = new Date().toISOString();
  const run = {
    version: 1,
    runId,
    subject: paths.subject,
    agentId: paths.agentId,
    createdAt: now,
    updatedAt: now,
    stages: Object.fromEntries(
      DISTILL_STAGE_ORDER.map((stage) => [stage, { status: 'pending' }]),
    ),
    sources,
    stats: {
      documentsAdded: 0,
      documentsTotal: 0,
      deltaDocuments: 0,
      claimsAdded: 0,
      claimsFlagged: 0,
      reviewsOpened: 0,
    },
    notes: [],
  };
  const runPaths = resolveDistillRunPaths(paths, runId);
  saveDistillRun(runPaths, run);
  emitDistillAuditEvent({
    subject: paths.subject,
    runId,
    type: 'distill.run.created',
    fields: { sources: sources.map((source) => source.path) },
  });
  return { run, runPaths };
}

export function loadDistillRun(paths, runId) {
  const runPaths = resolveDistillRunPaths(paths, runId);
  const run = readJsonFile(runPaths.runRecordPath);
  if (!run) return null;
  return { run, runPaths };
}

export function listDistillRuns(paths) {
  let entries;
  try {
    entries = fs.readdirSync(paths.runsRootDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    const run = readJsonFile(path.join(paths.runsRootDir, entry, 'run.json'));
    if (run && run.subject === paths.subject) runs.push(run);
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findLatestDistillRun(paths) {
  const runs = listDistillRuns(paths);
  const latest = runs[runs.length - 1];
  if (!latest) return null;
  return loadDistillRun(paths, latest.runId);
}

export function saveDistillRun(runPaths, run) {
  run.updatedAt = new Date().toISOString();
  writeJsonFile(runPaths.runRecordPath, run);
}

export function setDistillStage(runPaths, run, stage, status, detail) {
  const state = run.stages[stage];
  if (status === 'completed') {
    state.completedAt = new Date().toISOString();
    state.startedAt ||= state.completedAt;
  } else {
    state.startedAt ||= new Date().toISOString();
    state.completedAt = undefined;
  }
  state.status = status;
  state.detail = detail;
  saveDistillRun(runPaths, run);
  emitDistillAuditEvent({
    subject: run.subject,
    runId: run.runId,
    type: 'distill.stage.updated',
    fields: { stage, status, detail },
  });
}

export function renderRunReport(run, profile, extras = {}) {
  const lines = [
    `# Distillation Report — ${profile.displayName}`,
    '',
    `- **Run:** \`${run.runId}\``,
    `- **Subject:** \`${run.subject}\` (${profile.realPerson ? 'real person, consent on file' : 'fictional / composite'})`,
    `- **Agent workspace:** \`${run.agentId}\``,
    `- **Created:** ${run.createdAt}`,
    `- **Updated:** ${run.updatedAt}`,
    '',
    '## Stages',
    '',
    '| Stage | Status | Detail |',
    '|---|---|---|',
  ];
  for (const stage of DISTILL_STAGE_ORDER) {
    const state = run.stages[stage];
    lines.push(
      `| ${stage} | ${state.status} | ${state.detail ? state.detail.replace(/\n/g, ' ') : ''} |`,
    );
  }
  lines.push(
    '',
    '## Corpus',
    '',
    `- Documents added this run: ${run.stats.documentsAdded}`,
    `- Documents in corpus: ${run.stats.documentsTotal}`,
    `- Delta analysed this run: ${run.stats.deltaDocuments}`,
    '',
    '## Extraction',
    '',
    `- Claims merged: ${run.stats.claimsAdded}`,
    `- Claims flagged (unsupported or invalid, excluded from outputs): ${run.stats.claimsFlagged}`,
    `- Reviews opened (conflicting evidence awaiting operator): ${run.stats.reviewsOpened}`,
  );
  appendListSection(lines, 'Flagged for operator review', extras.flagged);
  appendListSection(lines, 'Open reviews', extras.reviews);
  appendListSection(lines, 'Warnings', extras.warnings);
  appendListSection(lines, 'Next steps', extras.nextSteps);
  if (run.notes.length > 0) {
    appendListSection(lines, 'Notes', run.notes);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeRunReport(runPaths, run, profile, extras) {
  fs.mkdirSync(runPaths.runDir, { recursive: true });
  fs.writeFileSync(
    runPaths.reportPath,
    renderRunReport(run, profile, extras),
    'utf-8',
  );
}

function appendListSection(lines, title, items) {
  if (!items || items.length === 0) return;
  lines.push('', `## ${title}`, '');
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}
