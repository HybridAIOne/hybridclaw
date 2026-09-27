/**
 * Skill guard text scan — applies line rules to one file's text and flags
 * invisible Unicode, returning findings without judging them.
 *
 * Owns the rule shape (`ThreatRule`) and how a rule applies to a line, not
 * the rules: the table, verdict, and trust policy live in `skills-guard.ts`,
 * the file walk in `skills-guard-structure.ts`.
 */
import fs from 'node:fs';
import type {
  SkillGuardCategory,
  SkillGuardFinding,
  SkillGuardSeverity,
} from './skills-guard.js';
import type { SkillFileEntry } from './skills-guard-structure.js';

export interface ThreatRule {
  patternId: string;
  severity: SkillGuardSeverity;
  category: Exclude<SkillGuardCategory, 'structural'>;
  description: string;
  regex: RegExp;
  /** Spans removed from a line before `regex` is tested. */
  ignore?: RegExp;
  /** Paths the rule skips because its syntax means something else there. */
  skipFiles?: RegExp;
}

/** Rule patterns match case-insensitively; a rule needing exact case passes its own RegExp. */
export function r(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

const SCANNABLE_EXTENSIONS = new Set<string>([
  '.md',
  '.txt',
  '.py',
  '.sh',
  '.bash',
  '.js',
  '.ts',
  '.rb',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.conf',
  '.html',
  '.css',
  '.xml',
  '.tex',
  '.r',
  '.jl',
  '.pl',
  '.php',
]);

const INVISIBLE_CHARS: readonly string[] = [
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\u2062',
  '\u2063',
  '\u2064',
  '\ufeff',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
] as const;

const INVISIBLE_CHAR_NAMES: Record<string, string> = {
  '\u200b': 'zero-width space',
  '\u200c': 'zero-width non-joiner',
  '\u200d': 'zero-width joiner',
  '\u2060': 'word joiner',
  '\u2062': 'invisible times',
  '\u2063': 'invisible separator',
  '\u2064': 'invisible plus',
  '\ufeff': 'BOM/zero-width no-break space',
  '\u202a': 'LTR embedding',
  '\u202b': 'RTL embedding',
  '\u202c': 'pop directional formatting',
  '\u202d': 'LTR override',
  '\u202e': 'RTL override',
  '\u2066': 'LTR isolate',
  '\u2067': 'RTL isolate',
  '\u2068': 'first strong isolate',
  '\u2069': 'pop directional isolate',
};

export function scanFile(
  entry: SkillFileEntry,
  rules: readonly ThreatRule[],
): SkillGuardFinding[] {
  if (entry.isBinary) return [];
  if (
    entry.extension !== '.md' &&
    entry.relativePath !== 'SKILL.md' &&
    !SCANNABLE_EXTENSIONS.has(entry.extension)
  ) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(entry.absolutePath, 'utf-8');
  } catch {
    return [];
  }

  return scanTextContent(entry.relativePath, content, rules);
}

export function scanTextContent(
  relativePath: string,
  content: string,
  rules: readonly ThreatRule[],
): SkillGuardFinding[] {
  const normalizedPath = relativePath.trim() || 'SKILL.md';

  const lines = content.split('\n');
  const seen = new Set<string>();
  const findings: SkillGuardFinding[] = [];

  for (const rule of rules) {
    if (rule.skipFiles?.test(normalizedPath)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      const line = lines[i] || '';
      const dedupeKey = `${rule.patternId}:${lineNo}`;
      if (seen.has(dedupeKey)) continue;
      const text = rule.ignore ? line.replace(rule.ignore, '') : line;
      if (!rule.regex.test(text)) continue;
      seen.add(dedupeKey);
      const matched = line.trim();
      findings.push({
        patternId: rule.patternId,
        severity: rule.severity,
        category: rule.category,
        file: normalizedPath,
        line: lineNo,
        match: matched.length > 120 ? `${matched.slice(0, 117)}...` : matched,
        description: rule.description,
      });
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i] || '';
    for (const char of INVISIBLE_CHARS) {
      if (!line.includes(char)) continue;
      const charName =
        INVISIBLE_CHAR_NAMES[char] ||
        `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`;
      findings.push({
        patternId: 'invisible_unicode',
        severity: 'high',
        category: 'prompt-injection',
        file: normalizedPath,
        line: lineNo,
        match: `U+${(char.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')} (${charName})`,
        description: `invisible unicode character ${charName} (possible text hiding/injection)`,
      });
      break;
    }
  }

  return findings;
}
