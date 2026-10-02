/**
 * Skill guard text scan — applies line rules to one file's text and flags
 * invisible Unicode, distinguishing literal diagnostics and documented unsafe
 * code examples from actions. Critical examples still produce findings.
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
  /** Spans removed from a matching line before `regex` is tested again. */
  ignore?: RegExp;
  /** Paths the rule skips because its syntax means something else there. */
  skipFiles?: RegExp;
  /** Literal diagnostics or test data can mention an operation without doing it. */
  ignoreLine?: (line: string, file: string, previousLine: string) => boolean;
}

const QUOTED_LITERAL = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
const PYTHON_DIAGNOSTIC = new RegExp(
  String.raw`^\s*raise\s+SystemExit\(\s*${QUOTED_LITERAL}\s*\)\s*$`,
);
const PYTHON_LITERAL_LINE = new RegExp(
  String.raw`^\s*${QUOTED_LITERAL}\s*,?\s*$`,
);
const SHELL_DIAGNOSTIC = new RegExp(
  String.raw`^\s*echo\s+${QUOTED_LITERAL}\s+>&2\s*$`,
);
const LITERAL_TEST_DATA = new RegExp(
  String.raw`^\s*const\s+\w+\s*=\s*${QUOTED_LITERAL}\s*;\s*$`,
);

export function isLiteralTestData(line: string, file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/i.test(file) && LITERAL_TEST_DATA.test(line);
}

export function isLiteralDiagnostic(
  line: string,
  file: string,
  previousLine: string,
): boolean {
  if (/\.py$/i.test(file)) {
    return (
      PYTHON_DIAGNOSTIC.test(line) ||
      (/^\s*raise\s+SystemExit\(\s*$/.test(previousLine) &&
        PYTHON_LITERAL_LINE.test(line))
    );
  }
  return (
    /\.(?:sh|bash|zsh)$/i.test(file) &&
    SHELL_DIAGNOSTIC.test(line) &&
    !/\$\(|`/.test(line)
  );
}

// Only code-operation rules use this context. A heading cannot excuse prompt
// injection, credential exposure, persistence, or critical findings.
const DOCUMENTED_CODE_CATEGORIES = new Set<SkillGuardCategory>([
  'exfiltration',
  'destructive-ops',
  'reverse-shells',
  'obfuscation',
]);

function insecureExampleLines(lines: string[]): Set<number> {
  const examples = new Set<number>();
  let inExamples = false;
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
      inExamples = false;
      continue;
    }
    if (fence) continue;
    if (/^Insecure patterns:\s*$/.test(line)) {
      inExamples = true;
    } else if (inExamples && /^\s*[-*]\s+/.test(line)) {
      examples.add(i);
    } else if (line.trim()) {
      inExamples = false;
    }
  }
  return examples;
}

function stripInlineCode(line: string): string {
  return line.replace(/(?<![\\`])`[^`\n]+`(?!`)/g, '');
}

/** Rule patterns match case-insensitively; a rule needing exact case passes its own RegExp. */
export function r(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

/**
 * `call` at its first occurrence on the line only. `firstOnLine(call)[^\n]*X`
 * flags the same lines as `call[^\n]*X`, since an X after any later call also
 * follows the first, but looks for X once rather than once per call, which
 * was quadratic on a line of repeated calls; a lazy `[^\n]*?X` also reads the
 * line once instead of to its end and back. `call` leads so the regex engine
 * can skip to it. End it in something fixed (`curl\s`, not `curl\s+`): the
 * lookbehind matches it backward from every earlier position on the line.
 */
export function firstOnLine(call: string): string {
  return String.raw`${call}(?<!${call}[^\n]*?${call})`;
}

// Instructions, config, and scripts. Every JavaScript and TypeScript module
// type is listed: the documented skill helper is a `.cjs` file, and `node`,
// `tsx`, or `bun` runs each of them directly. A shebang script is read
// whatever its name.
const SCANNABLE_EXTENSIONS = new Set<string>([
  '.md',
  '.txt',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.js',
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.cts',
  '.mts',
  '.tsx',
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

const INVISIBLE_DATA_LITERAL = new RegExp(
  String.raw`^\s*(?:const|let|var)\s+\w+\s*=\s*(['"])[${INVISIBLE_CHARS.join('')}]+\1\s*;?\s*$`,
);
const INVISIBLE_REGEX_CLASS = new RegExp(
  String.raw`(?<=\.replace\(\s*)/\[[${INVISIBLE_CHARS.join('')}-]+\]/[gimuys]*`,
  'g',
);

function visibleCodeLine(line: string, file: string): string {
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return line;
  if (INVISIBLE_DATA_LITERAL.test(line)) return '';
  // Character-only data, a removal regex, and a BOM in a frontmatter fixture
  // contain no concealed text. Inspect the rest of the line as usual.
  return line
    .replace(INVISIBLE_REGEX_CLASS, '')
    .replace(/(?<=['"])\ufeff(?=---\\n)/g, '');
}

export function scanFile(
  entry: SkillFileEntry,
  rules: readonly ThreatRule[],
): SkillGuardFinding[] {
  if (entry.isBinary) return [];
  if (!entry.hasShebang && !SCANNABLE_EXTENSIONS.has(entry.extension)) {
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
  const examples = /\.md$/i.test(normalizedPath)
    ? insecureExampleLines(lines)
    : new Set<number>();
  const seen = new Set<string>();
  const findings: SkillGuardFinding[] = [];

  for (const rule of rules) {
    if (rule.skipFiles?.test(normalizedPath)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      const line = lines[i] || '';
      const dedupeKey = `${rule.patternId}:${lineNo}`;
      if (seen.has(dedupeKey)) continue;
      if (!rule.regex.test(line)) continue;
      // Only lines that match pay for `ignore`; stripping every line cost
      // several times more than the rules themselves.
      if (rule.ignore && !rule.regex.test(line.replace(rule.ignore, '')))
        continue;
      if (rule.ignoreLine?.(line, normalizedPath, lines[i - 1] || '')) continue;
      if (
        examples.has(i) &&
        rule.severity !== 'critical' &&
        DOCUMENTED_CODE_CATEGORIES.has(rule.category) &&
        !rule.regex.test(stripInlineCode(line))
      )
        continue;
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
    const line = visibleCodeLine(lines[i] || '', normalizedPath);
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
