import fs from 'node:fs';

import { readJsonFile, writeJsonFile } from './paths.js';

export function loadSubjectProfile(paths) {
  return readJsonFile(paths.subjectProfilePath);
}

export function requireSubjectProfile(paths) {
  const profile = loadSubjectProfile(paths);
  if (!profile) {
    throw new Error(
      `No coworker subject found for \`${paths.subject}\`. Start with \`hybridclaw coworker distill --alias ${paths.subject} --name "<display name>" --source <path>\`.`,
    );
  }
  return profile;
}

export function ensureSubjectProfile(paths, input) {
  const existing = loadSubjectProfile(paths);
  if (existing) {
    const displayName = input.displayName?.trim() || existing.displayName;
    const updated = {
      ...existing,
      displayName,
      role: input.role?.trim() || existing.role,
      relationship: input.relationship?.trim() || existing.relationship,
      personalityTags: mergeUnique(
        existing.personalityTags,
        input.personalityTags,
      ),
      // A display name set after creation must also match authorship, or
      // chat-export author resolution would miss the subject's own messages.
      matchAliases: mergeUnique(existing.matchAliases, [
        displayName,
        ...(input.matchAliases || []),
      ]),
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
  const profile = {
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

function mergeUnique(base, extra) {
  const merged = new Set();
  for (const value of [...base, ...(extra || [])]) {
    const trimmed = String(value || '').trim();
    if (trimmed) merged.add(trimmed);
  }
  return [...merged];
}
