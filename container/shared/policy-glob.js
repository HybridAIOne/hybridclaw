/**
 * Globs in operator-written policy (`pinned_red` and network paths, hosts,
 * secret ids and selectors). `*`, `**`, and `?` (one character) are the only
 * wildcards and every other character is literal, so no pattern fails to
 * compile; matches are anchored and case-insensitive. NOT shell globs: `[...]`
 * and `{a,b}` stay literal (`bash-pinned-reach.ts` reads shell globs).
 */
import { escapeRegExp } from './regex.js';

const WILDCARD_SOURCES_BY_KIND = new Map([
  // `*` and `?` stay inside one `/` segment; `**` crosses segments.
  [
    'path',
    new Map([
      ['**', '.*'],
      ['*', '[^/]*'],
      ['?', '[^/]'],
    ]),
  ],
  // `*` spans labels, so `*.example.com` covers nested subdomains. `?` stays
  // inside one label so `ex?mple.com` cannot reach a host under `mple.com`
  // (fail-closed call, 2026-09-27; an infix `*` still spans labels, deferred).
  [
    'host',
    new Map([
      ['**', '.*'],
      ['*', '.*'],
      ['?', '[^.]'],
    ]),
  ],
  // Secret ids and selectors have no separator.
  [
    'text',
    new Map([
      ['**', '.*'],
      ['*', '.*'],
      ['?', '.'],
    ]),
  ],
]);

export function hasGlobWildcard(pattern) {
  return /[*?]/.test(pattern);
}

export function globToRegExp(pattern, kind) {
  const wildcardSources = WILDCARD_SOURCES_BY_KIND.get(kind);
  if (!wildcardSources) throw new Error(`Unknown policy glob kind: ${kind}`);
  const source = pattern.replace(
    /\*\*|[*?]|[^*?]+/g,
    (token) => wildcardSources.get(token) ?? escapeRegExp(token),
  );
  return new RegExp(`^${source}$`, 'i');
}
