import type {
  ConfidentialRule,
  ConfidentialRuleSet,
  ConfidentialSensitivity,
} from './confidential-rules.js';

const PLACEHOLDER_PREFIX = '«CONF:';
const PLACEHOLDER_SUFFIX = '»';
const PLACEHOLDER_RE = /«CONF:([A-Z0-9_-]+)»/g;

const SENSITIVITY_WEIGHTS: Record<ConfidentialSensitivity, number> = {
  low: 3,
  medium: 10,
  high: 30,
  critical: 100,
};

const SCORE_BUCKETS: ReadonlyArray<{
  min: number;
  level: ConfidentialSensitivity;
}> = [
  { min: 100, level: 'critical' },
  { min: 30, level: 'high' },
  { min: 10, level: 'medium' },
  { min: 0, level: 'low' },
];

const MAX_SCORE = 1000;

export interface ConfidentialPlaceholderMap {
  /** placeholder token → original text (case as it appeared in source) */
  byPlaceholder: Map<string, string>;
  /** rule id → placeholder token */
  byRuleId: Map<string, string>;
}

export interface DehydrateResult {
  text: string;
  mappings: ConfidentialPlaceholderMap;
  hits: number;
}

export interface ConfidentialFinding {
  ruleId: string;
  kind: ConfidentialRule['kind'];
  label: string;
  sensitivity: ConfidentialSensitivity;
  matches: number;
  /** A short text excerpt around the first match, redacted. */
  excerpt: string;
}

export interface ConfidentialScanResult {
  findings: ConfidentialFinding[];
  totalMatches: number;
  /** raw weighted score (sum of sensitivity weights × matches), capped at {@link MAX_SCORE}. */
  rawScore: number;
  /** 0–100 normalized score for dashboards. */
  score: number;
  severity: ConfidentialSensitivity;
}

export function createPlaceholderMap(): ConfidentialPlaceholderMap {
  return { byPlaceholder: new Map(), byRuleId: new Map() };
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalRegex(rule: ConfidentialRule): RegExp | null {
  const variants = [rule.literal, ...(rule.literalAliases || [])].filter(
    (entry): entry is string => Boolean(entry),
  );
  if (variants.length === 0) return null;
  variants.sort((a, b) => b.length - a.length);
  const pattern = variants.map(escapeForRegex).join('|');
  const flags = rule.caseInsensitive ? 'giu' : 'gu';
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${pattern})(?![\\p{L}\\p{N}_])`,
    flags,
  );
}

function ruleRegex(rule: ConfidentialRule): RegExp | null {
  if (rule.regex) {
    return new RegExp(rule.regex.source, rule.caseInsensitive ? 'gi' : 'g');
  }
  return literalRegex(rule);
}

function placeholderForRule(
  rule: ConfidentialRule,
  mappings: ConfidentialPlaceholderMap,
): string {
  const existing = mappings.byRuleId.get(rule.id);
  if (existing) return existing;
  const token = `${PLACEHOLDER_PREFIX}${rule.id.toUpperCase()}${PLACEHOLDER_SUFFIX}`;
  mappings.byRuleId.set(rule.id, token);
  return token;
}

export function dehydrateConfidential(
  text: string,
  ruleSet: ConfidentialRuleSet,
  initialMappings?: ConfidentialPlaceholderMap,
): DehydrateResult {
  const mappings = initialMappings || createPlaceholderMap();
  if (!text || ruleSet.rules.length === 0) {
    return { text: text || '', mappings, hits: 0 };
  }

  let next = text;
  let hits = 0;

  for (const rule of ruleSet.rules) {
    const regex = ruleRegex(rule);
    if (!regex) continue;
    const placeholder = placeholderForRule(rule, mappings);

    next = next.replace(regex, (match) => {
      hits += 1;
      if (!mappings.byPlaceholder.has(placeholder)) {
        mappings.byPlaceholder.set(placeholder, match);
      }
      return placeholder;
    });
  }

  return { text: next, mappings, hits };
}

export function rehydrateConfidential(
  text: string,
  mappings: ConfidentialPlaceholderMap,
): string {
  if (!text || mappings.byPlaceholder.size === 0) return text;
  return text.replace(PLACEHOLDER_RE, (match) => {
    const original = mappings.byPlaceholder.get(match);
    return original ?? match;
  });
}

function buildExcerpt(
  source: string,
  matchIndex: number,
  matchLength: number,
  width = 60,
): string {
  if (matchIndex < 0) return '';
  const start = Math.max(0, matchIndex - width);
  const end = Math.min(source.length, matchIndex + matchLength + width);
  const before = source.slice(start, matchIndex);
  const after = source.slice(matchIndex + matchLength, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < source.length ? '...' : '';
  return `${prefix}${before}***${after}${suffix}`.replace(/\s+/g, ' ').trim();
}

export function scanForLeaks(
  text: string,
  ruleSet: ConfidentialRuleSet,
): ConfidentialScanResult {
  const findings: ConfidentialFinding[] = [];
  if (!text || ruleSet.rules.length === 0) {
    return {
      findings,
      totalMatches: 0,
      rawScore: 0,
      score: 0,
      severity: 'low',
    };
  }

  let totalMatches = 0;
  let rawScore = 0;

  for (const rule of ruleSet.rules) {
    const regex = ruleRegex(rule);
    if (!regex) continue;
    let matches = 0;
    let firstIndex = -1;
    let firstLength = 0;
    let result: RegExpExecArray | null = regex.exec(text);
    while (result) {
      matches += 1;
      if (firstIndex === -1) {
        firstIndex = result.index;
        firstLength = result[0].length;
      }
      if (regex.lastIndex === result.index) regex.lastIndex += 1;
      result = regex.exec(text);
    }
    if (matches === 0) continue;
    totalMatches += matches;
    rawScore += SENSITIVITY_WEIGHTS[rule.sensitivity] * matches;
    findings.push({
      ruleId: rule.id,
      kind: rule.kind,
      label: rule.label,
      sensitivity: rule.sensitivity,
      matches,
      excerpt: buildExcerpt(text, firstIndex, firstLength),
    });
  }

  const cappedRaw = Math.min(rawScore, MAX_SCORE);
  const score = Math.round((cappedRaw / MAX_SCORE) * 100);
  const severity =
    SCORE_BUCKETS.find((bucket) => cappedRaw >= bucket.min)?.level || 'low';

  findings.sort((a, b) => {
    const sevDiff =
      SENSITIVITY_WEIGHTS[b.sensitivity] - SENSITIVITY_WEIGHTS[a.sensitivity];
    if (sevDiff !== 0) return sevDiff;
    if (b.matches !== a.matches) return b.matches - a.matches;
    return a.label.localeCompare(b.label);
  });

  return {
    findings,
    totalMatches,
    rawScore: cappedRaw,
    score,
    severity,
  };
}

export function mergePlaceholderMaps(
  base: ConfidentialPlaceholderMap,
  next: ConfidentialPlaceholderMap,
): ConfidentialPlaceholderMap {
  for (const [token, original] of next.byPlaceholder) {
    if (!base.byPlaceholder.has(token)) {
      base.byPlaceholder.set(token, original);
    }
  }
  for (const [ruleId, token] of next.byRuleId) {
    if (!base.byRuleId.has(ruleId)) {
      base.byRuleId.set(ruleId, token);
    }
  }
  return base;
}
