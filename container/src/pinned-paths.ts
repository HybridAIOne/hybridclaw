/**
 * Pinned path patterns shared by the approval policy and the grep tool.
 *
 * The policy sends calls whose path args match a pinned pattern to explicit
 * approval; grep skips matching files in directory walks the policy cannot
 * see. Both use this matcher, so a grep call that names a pinned path is always
 * one the policy gated. NOT the loader for configured `approval.pinned_red`
 * rules, which stays in approval-policy.ts.
 */
import path from 'node:path';
import { globToRegExp } from '../shared/policy-glob.js';
import { expandUserPath } from './runtime-paths.js';

// Safety net that a policy file replacing `approval.pinned_red` cannot drop.
// grep walks skip only this list (owner call, 2026-09-23); configured
// `pinned_red` paths gate explicit path args but not the files a walk reaches.
export const HARD_PINNED_PATH_PATTERNS: readonly string[] = [
  '.env*',
  '/etc/**',
  '~/.ssh/**',
];

// Like picomatch, `dir/**` also matches `dir` itself: searching that
// directory reaches everything below it.
function pathGlobMatcher(pattern: string): (value: string) => boolean {
  const patterns = pattern.endsWith('/**')
    ? [pattern, pattern.slice(0, -'/**'.length)]
    : [pattern];
  const regexps = patterns.map((entry) => globToRegExp(entry, 'path'));
  return (value) => regexps.some((regexp) => regexp.test(value));
}

export function normalizePathValue(rawPath: string): string {
  const value = rawPath.trim().replace(/\\/g, '/');
  const withoutWorkspace = value.startsWith('/workspace/')
    ? value.slice('/workspace/'.length)
    : value;
  return withoutWorkspace.replace(/^\.\/+/, '').replace(/^\/+/, '');
}

// Resolve `~` and `..` the way file tools do, so `/home/me/.ssh/id_rsa` and
// `/workspace/../etc/passwd` meet the same pinned rules as their short forms.
function normalizeAbsolutePathValue(rawPath: string): string {
  return path.posix.normalize(expandUserPath(rawPath).replace(/\\/g, '/'));
}

export function matchesPathPattern(
  candidatePath: string,
  pattern: string,
): boolean {
  const normalizedCandidate = normalizePathValue(candidatePath);
  const normalizedPattern = pattern.trim().replace(/\\/g, '/');
  if (!normalizedPattern) return false;

  // Relative patterns (e.g. ".env*") should match both root and any nested path.
  if (
    !normalizedPattern.startsWith('/') &&
    !normalizedPattern.startsWith('~/')
  ) {
    const relativePattern = normalizedPattern.replace(/^\.\//, '');
    const matchesRelative = pathGlobMatcher(relativePattern);
    if (matchesRelative(normalizedCandidate)) return true;
    // Only slash-free patterns match a file name at any depth; `secrets/**`
    // must not match an unrelated file named `docs/secrets`.
    if (relativePattern.includes('/')) return false;
    return matchesRelative(path.posix.basename(normalizedCandidate));
  }

  const matchesAbsolute = pathGlobMatcher(
    normalizeAbsolutePathValue(normalizedPattern),
  );
  return matchesAbsolute(normalizeAbsolutePathValue(candidatePath));
}

export function matchesHardPinnedPath(candidatePath: string): boolean {
  return HARD_PINNED_PATH_PATTERNS.some((pattern) =>
    matchesPathPattern(candidatePath, pattern),
  );
}
