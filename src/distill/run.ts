import fs from 'node:fs';
import path from 'node:path';
import { emitDistillAuditEvent } from './audit.js';
import type { DistillPaths, DistillRunPaths } from './paths.js';
import {
  makeDistillRunId,
  readJsonFile,
  resolveDistillRunPaths,
  writeJsonFile,
} from './paths.js';
import type {
  DistillRunRecord,
  DistillRunSource,
  DistillStageName,
  DistillStageStatus,
  SubjectProfile,
} from './types.js';
import { DISTILL_STAGE_ORDER } from './types.js';

export function createDistillRun(
  paths: DistillPaths,
  sources: DistillRunSource[],
): { run: DistillRunRecord; runPaths: DistillRunPaths } {
  const runId = makeDistillRunId();
  const now = new Date().toISOString();
  const run: DistillRunRecord = {
    version: 1,
    runId,
    subject: paths.subject,
    agentId: paths.agentId,
    createdAt: now,
    updatedAt: now,
    stages: Object.fromEntries(
      DISTILL_STAGE_ORDER.map((stage) => [stage, { status: 'pending' }]),
    ) as DistillRunRecord['stages'],
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

export function loadDistillRun(
  paths: DistillPaths,
  runId: string,
): { run: DistillRunRecord; runPaths: DistillRunPaths } | null {
  const runPaths = resolveDistillRunPaths(paths, runId);
  const run = readJsonFile<DistillRunRecord>(runPaths.runRecordPath);
  if (!run) return null;
  return { run, runPaths };
}

export function listDistillRuns(paths: DistillPaths): DistillRunRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.runsRootDir);
  } catch {
    return [];
  }
  const runs: DistillRunRecord[] = [];
  for (const entry of entries) {
    const run = readJsonFile<DistillRunRecord>(
      path.join(paths.runsRootDir, entry, 'run.json'),
    );
    if (run && run.subject === paths.subject) runs.push(run);
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findLatestDistillRun(
  paths: DistillPaths,
): { run: DistillRunRecord; runPaths: DistillRunPaths } | null {
  const runs = listDistillRuns(paths);
  const latest = runs[runs.length - 1];
  if (!latest) return null;
  return loadDistillRun(paths, latest.runId);
}

export function saveDistillRun(
  runPaths: DistillRunPaths,
  run: DistillRunRecord,
): void {
  run.updatedAt = new Date().toISOString();
  writeJsonFile(runPaths.runRecordPath, run);
}

export function setDistillStage(
  runPaths: DistillRunPaths,
  run: DistillRunRecord,
  stage: DistillStageName,
  status: DistillStageStatus,
  detail?: string,
): void {
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

export function nextPendingStage(
  run: DistillRunRecord,
): DistillStageName | null {
  for (const stage of DISTILL_STAGE_ORDER) {
    if (run.stages[stage].status !== 'completed') return stage;
  }
  return null;
}

export function renderRunReport(
  run: DistillRunRecord,
  profile: SubjectProfile,
  extras: {
    warnings?: string[];
    flagged?: string[];
    reviews?: string[];
    nextSteps?: string[];
  } = {},
): string {
  const lines: string[] = [
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

export function writeRunReport(
  runPaths: DistillRunPaths,
  run: DistillRunRecord,
  profile: SubjectProfile,
  extras?: Parameters<typeof renderRunReport>[2],
): void {
  fs.mkdirSync(runPaths.runDir, { recursive: true });
  fs.writeFileSync(
    runPaths.reportPath,
    renderRunReport(run, profile, extras),
    'utf-8',
  );
}

function appendListSection(
  lines: string[],
  title: string,
  items?: string[],
): void {
  if (!items || items.length === 0) return;
  lines.push('', `## ${title}`, '');
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}
