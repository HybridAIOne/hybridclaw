import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agentWorkspaceDir } from '../infra/ipc.js';

const SUBJECT_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function normalizeSubjectAlias(raw: string): string {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!SUBJECT_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid coworker alias: ${JSON.stringify(raw)}. Use lowercase letters, digits, and dashes (max 64 chars).`,
    );
  }
  return slug;
}

export interface DistillPaths {
  agentId: string;
  subject: string;
  workspaceDir: string;
  subjectDir: string;
  subjectProfilePath: string;
  consentPath: string;
  corpusDir: string;
  corpusDocumentsPath: string;
  statePath: string;
  reviewsDir: string;
  correctionsPath: string;
  runsRootDir: string;
}

export function resolveDistillPaths(
  agentId: string,
  subject: string,
): DistillPaths {
  const alias = normalizeSubjectAlias(subject);
  const workspaceDir = agentWorkspaceDir(agentId);
  const subjectDir = path.join(workspaceDir, 'distill', alias);
  const corpusDir = path.join(subjectDir, 'corpus');
  return {
    agentId,
    subject: alias,
    workspaceDir,
    subjectDir,
    subjectProfilePath: path.join(subjectDir, 'subject.json'),
    consentPath: path.join(subjectDir, 'consent.json'),
    corpusDir,
    corpusDocumentsPath: path.join(corpusDir, 'documents.jsonl'),
    statePath: path.join(subjectDir, 'state.json'),
    reviewsDir: path.join(subjectDir, 'reviews'),
    correctionsPath: path.join(subjectDir, 'corrections.jsonl'),
    runsRootDir: path.join(workspaceDir, 'runtime', 'distill'),
  };
}

export interface DistillRunPaths {
  runDir: string;
  runRecordPath: string;
  reportPath: string;
  analysisDir: string;
  packetJsonPath: string;
  packetMarkdownPath: string;
  extractionPath: string;
  evalPath: string;
}

export function resolveDistillRunPaths(
  paths: DistillPaths,
  runId: string,
): DistillRunPaths {
  if (!/^[a-z0-9_-]+$/i.test(runId)) {
    throw new Error(`Invalid distill run id: ${JSON.stringify(runId)}`);
  }
  const runDir = path.join(paths.runsRootDir, runId);
  const analysisDir = path.join(runDir, 'analysis');
  return {
    runDir,
    runRecordPath: path.join(runDir, 'run.json'),
    reportPath: path.join(runDir, 'REPORT.md'),
    analysisDir,
    packetJsonPath: path.join(analysisDir, 'packet.json'),
    packetMarkdownPath: path.join(analysisDir, 'PACKET.md'),
    extractionPath: path.join(analysisDir, 'extraction.json'),
    evalPath: path.join(runDir, 'eval.json'),
  };
}

export function makeDistillRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `dst_${stamp}_${rand}`;
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}
