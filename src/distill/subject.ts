import fs from 'node:fs';
import type { DistillPaths } from './paths.js';
import { readJsonFile, writeJsonFile } from './paths.js';
import type { SubjectProfile } from './types.js';

export interface CreateSubjectInput {
  alias: string;
  displayName?: string;
  realPerson?: boolean;
  role?: string;
  relationship?: string;
  personalityTags?: string[];
  matchAliases?: string[];
}

export function loadSubjectProfile(paths: DistillPaths): SubjectProfile | null {
  return readJsonFile<SubjectProfile>(paths.subjectProfilePath);
}

export function requireSubjectProfile(paths: DistillPaths): SubjectProfile {
  const profile = loadSubjectProfile(paths);
  if (!profile) {
    throw new Error(
      `No coworker subject found for \`${paths.subject}\`. Start with \`hybridclaw coworker distill --alias ${paths.subject} --name "<display name>" --source <path>\`.`,
    );
  }
  return profile;
}

export function ensureSubjectProfile(
  paths: DistillPaths,
  input: CreateSubjectInput,
): { profile: SubjectProfile; created: boolean } {
  const existing = loadSubjectProfile(paths);
  if (existing) {
    const updated: SubjectProfile = {
      ...existing,
      displayName: input.displayName?.trim() || existing.displayName,
      role: input.role?.trim() || existing.role,
      relationship: input.relationship?.trim() || existing.relationship,
      personalityTags: mergeUnique(
        existing.personalityTags,
        input.personalityTags,
      ),
      matchAliases: mergeUnique(existing.matchAliases, input.matchAliases),
    };
    if (input.realPerson !== undefined) {
      updated.realPerson = input.realPerson;
    }
    if (JSON.stringify(updated) !== JSON.stringify(existing)) {
      writeJsonFile(paths.subjectProfilePath, updated);
    }
    return { profile: updated, created: false };
  }

  const displayName = input.displayName?.trim() || paths.subject;
  const profile: SubjectProfile = {
    version: 1,
    alias: paths.subject,
    displayName,
    // Deny-by-default: a subject is a real person unless explicitly marked
    // fictional, so the consent gate applies before the first run.
    realPerson: input.realPerson ?? true,
    role: input.role?.trim() || undefined,
    relationship: input.relationship?.trim() || undefined,
    personalityTags: mergeUnique([], input.personalityTags),
    matchAliases: mergeUnique([displayName, paths.subject], input.matchAliases),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(paths.subjectDir, { recursive: true });
  writeJsonFile(paths.subjectProfilePath, profile);
  return { profile, created: true };
}

function mergeUnique(base: string[], extra?: string[]): string[] {
  const merged = new Set<string>();
  for (const value of [...base, ...(extra || [])]) {
    const trimmed = String(value || '').trim();
    if (trimmed) merged.add(trimmed);
  }
  return [...merged];
}
