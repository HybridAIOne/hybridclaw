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
  // `*` and `?` stay inside one label and `**` spans labels, so `example.*`
  // cannot reach `example.attacker.com` (owner call, 2026-09-27: rules that
  // must span labels write `**`; old rules get no load-time warning).
  // hostGlobPattern keeps the documented leading `*.` and bare `*` spanning.
  [
    'host',
    new Map([
      ['**', '.*'],
      ['*', '[^.]*'],
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

// A leading `*.` covers subdomains at any depth and a bare `*` covers every
// host, so both span labels like `**`.
function hostGlobPattern(pattern) {
  if (pattern === '*') return '**';
  return pattern.startsWith('*.') ? `*${pattern}` : pattern;
}

export function hasGlobWildcard(pattern) {
  return /[*?]/.test(pattern);
}

export function globToRegExp(pattern, kind) {
  const wildcardSources = WILDCARD_SOURCES_BY_KIND.get(kind);
  if (!wildcardSources) throw new Error(`Unknown policy glob kind: ${kind}`);
  const expanded = kind === 'host' ? hostGlobPattern(pattern) : pattern;
  const source = expanded.replace(
    /\*\*|[*?]|[^*?]+/g,
    (token) => wildcardSources.get(token) ?? escapeRegExp(token),
  );
  return new RegExp(`^${source}$`, 'i');
}
