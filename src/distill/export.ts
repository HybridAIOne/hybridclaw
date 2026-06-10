import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitDistillAuditEvent } from './audit.js';
import { loadConsentArtefact } from './consent.js';
import type { DistillPaths } from './paths.js';
import { readJsonFile, writeJsonFile } from './paths.js';
import { loadDistillState, saveDistillState } from './state.js';
import { ensureSubjectProfile } from './subject.js';
import type { DistillState, SubjectProfile } from './types.js';

export const COWORKER_EXPORT_HOSTS = [
  'claude-code',
  'codex',
  'openclaw',
  'hybridclaw',
] as const;

export type CoworkerExportHost = (typeof COWORKER_EXPORT_HOSTS)[number];

export interface CoworkerBundleManifest {
  version: 1;
  subject: string;
  displayName: string;
  skillName: string;
  exportedAt: string;
  files: string[];
  claims: number;
  consent: { sha256: string; recordedAt: string } | null;
  includesCorpus: boolean;
}

const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'CV.md'] as const;

/**
 * One canonical bundle (R72.8): persona files + the generated skill +
 * distillation state, with a manifest. Corpus is excluded unless explicitly
 * requested — the bundle re-instantiates the coworker, it does not republish
 * the subject's source material.
 */
export function exportCoworkerBundle(
  paths: DistillPaths,
  profile: SubjectProfile,
  outDir: string,
  options: { includeCorpus?: boolean } = {},
): { bundleDir: string; manifest: CoworkerBundleManifest } {
  const state = loadDistillState(paths);
  if (!state.skillName || state.mergeHistory.length === 0) {
    throw new Error(
      `Nothing to export for \`${paths.subject}\` yet — complete a distillation run first.`,
    );
  }
  const bundleDir = path.join(outDir, `coworker-${paths.subject}`);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  const files: string[] = [];
  const personaDir = path.join(bundleDir, 'persona');
  fs.mkdirSync(personaDir, { recursive: true });
  for (const filename of PERSONA_FILES) {
    const source = path.join(paths.workspaceDir, filename);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(personaDir, filename));
    files.push(`persona/${filename}`);
  }

  const skillSource = path.join(paths.workspaceDir, 'skills', state.skillName);
  const skillTarget = path.join(bundleDir, 'skills', state.skillName);
  if (fs.existsSync(skillSource)) {
    fs.cpSync(skillSource, skillTarget, { recursive: true });
    for (const file of listFilesRecursive(skillTarget)) {
      files.push(path.relative(bundleDir, file));
    }
  }

  fs.copyFileSync(
    paths.subjectProfilePath,
    path.join(bundleDir, 'subject.json'),
  );
  files.push('subject.json');
  writeJsonFile(path.join(bundleDir, 'state.json'), state);
  files.push('state.json');

  if (options.includeCorpus && fs.existsSync(paths.corpusDocumentsPath)) {
    const corpusDir = path.join(bundleDir, 'corpus');
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.copyFileSync(
      paths.corpusDocumentsPath,
      path.join(corpusDir, 'documents.jsonl'),
    );
    files.push('corpus/documents.jsonl');
  }

  const consent = loadConsentArtefact(paths);
  const manifest: CoworkerBundleManifest = {
    version: 1,
    subject: paths.subject,
    displayName: profile.displayName,
    skillName: state.skillName,
    exportedAt: new Date().toISOString(),
    files,
    claims: state.claims.filter((claim) => claim.status === 'standing').length,
    consent: consent
      ? { sha256: consent.sha256, recordedAt: consent.recordedAt }
      : null,
    includesCorpus: Boolean(options.includeCorpus),
  };
  writeJsonFile(path.join(bundleDir, 'manifest.json'), manifest);
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: 'export',
    type: 'distill.export.created',
    fields: {
      bundleDir,
      files: files.length,
      includesCorpus: manifest.includesCorpus,
    },
  });
  return { bundleDir, manifest };
}

/**
 * Thin per-host adapters: every supported host consumes the same canonical
 * bundle; installing means copying the skill into that host's skill root and
 * the persona alongside it.
 */
export function resolveHostSkillRoot(
  host: CoworkerExportHost,
  homeDir = os.homedir(),
): string {
  switch (host) {
    case 'claude-code':
      return path.join(homeDir, '.claude', 'skills');
    case 'codex':
      return path.join(homeDir, '.codex', 'skills');
    case 'openclaw':
      return path.join(homeDir, '.openclaw', 'skills');
    case 'hybridclaw':
      return path.join(homeDir, '.hybridclaw', 'skills');
    default:
      throw new Error(`Unsupported export host: ${String(host)}`);
  }
}

export function installCoworkerBundle(
  bundleDir: string,
  host: CoworkerExportHost,
  homeDir = os.homedir(),
): { installedTo: string; skillName: string } {
  const manifest = readJsonFile<CoworkerBundleManifest>(
    path.join(bundleDir, 'manifest.json'),
  );
  if (!manifest) {
    throw new Error(
      `Not a coworker bundle (missing manifest.json): ${bundleDir}`,
    );
  }
  const skillRoot = resolveHostSkillRoot(host, homeDir);
  const target = path.join(skillRoot, manifest.skillName);
  const skillSource = path.join(bundleDir, 'skills', manifest.skillName);
  if (!fs.existsSync(skillSource)) {
    throw new Error(`Bundle is missing its skill directory: ${skillSource}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(skillSource, target, { recursive: true });
  const personaSource = path.join(bundleDir, 'persona');
  if (fs.existsSync(personaSource)) {
    fs.cpSync(personaSource, path.join(target, 'references', 'persona'), {
      recursive: true,
    });
  }
  emitDistillAuditEvent({
    subject: manifest.subject,
    runId: 'export',
    type: 'distill.export.installed',
    fields: { host, installedTo: target },
  });
  return { installedTo: target, skillName: manifest.skillName };
}

/**
 * Round-trip import: re-instantiates persona files, generated skill, state,
 * and subject profile into an agent workspace without re-distillation.
 */
export function importCoworkerBundle(
  bundleDir: string,
  paths: DistillPaths,
): CoworkerBundleManifest {
  const manifest = readJsonFile<CoworkerBundleManifest>(
    path.join(bundleDir, 'manifest.json'),
  );
  if (!manifest) {
    throw new Error(
      `Not a coworker bundle (missing manifest.json): ${bundleDir}`,
    );
  }
  const bundleProfile = readJsonFile<SubjectProfile>(
    path.join(bundleDir, 'subject.json'),
  );
  if (bundleProfile) {
    ensureSubjectProfile(paths, {
      alias: paths.subject,
      displayName: bundleProfile.displayName,
      realPerson: bundleProfile.realPerson,
      role: bundleProfile.role,
      relationship: bundleProfile.relationship,
      personalityTags: bundleProfile.personalityTags,
      matchAliases: bundleProfile.matchAliases,
    });
  }
  const personaSource = path.join(bundleDir, 'persona');
  for (const filename of PERSONA_FILES) {
    const source = path.join(personaSource, filename);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(paths.workspaceDir, { recursive: true });
    fs.copyFileSync(source, path.join(paths.workspaceDir, filename));
  }
  const skillSource = path.join(bundleDir, 'skills', manifest.skillName);
  if (fs.existsSync(skillSource)) {
    const skillTarget = path.join(
      paths.workspaceDir,
      'skills',
      manifest.skillName,
    );
    fs.rmSync(skillTarget, { recursive: true, force: true });
    fs.cpSync(skillSource, skillTarget, { recursive: true });
  }
  const state = readJsonFile<DistillState>(path.join(bundleDir, 'state.json'));
  if (state) {
    saveDistillState(paths, { ...state, subject: paths.subject });
  }
  const corpusSource = path.join(bundleDir, 'corpus', 'documents.jsonl');
  if (fs.existsSync(corpusSource)) {
    fs.mkdirSync(paths.corpusDir, { recursive: true });
    fs.copyFileSync(corpusSource, paths.corpusDocumentsPath);
  }
  emitDistillAuditEvent({
    subject: paths.subject,
    runId: 'export',
    type: 'distill.export.imported',
    fields: { bundleDir },
  });
  return manifest;
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile()) files.push(path.join(entry.parentPath, entry.name));
  }
  return files;
}
