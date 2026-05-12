import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

export const CONFIDENTIAL_CONFIG_FILE = '.confidential.yml';

export type ConfidentialSensitivity = 'low' | 'medium' | 'high' | 'critical';

export type ConfidentialKind =
  | 'client'
  | 'project'
  | 'person'
  | 'keyword'
  | 'pattern';

export interface ConfidentialRule {
  id: string;
  kind: ConfidentialKind;
  label: string;
  sensitivity: ConfidentialSensitivity;
  literal?: string;
  literalAliases?: string[];
  regex?: RegExp;
  regexSource?: string;
  caseInsensitive: boolean;
}

export interface ConfidentialRuleSet {
  rules: ConfidentialRule[];
  sourcePath: string | null;
}

interface RawEntry {
  name?: unknown;
  label?: unknown;
  aliases?: unknown;
  sensitivity?: unknown;
  case_insensitive?: unknown;
  caseInsensitive?: unknown;
  term?: unknown;
  regex?: unknown;
}

interface RawConfig {
  version?: unknown;
  clients?: unknown;
  projects?: unknown;
  people?: unknown;
  keywords?: unknown;
  patterns?: unknown;
}

const DEFAULT_SENSITIVITY: ConfidentialSensitivity = 'high';
const VALID_SENSITIVITIES: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'critical',
]);

function normalizeSensitivity(raw: unknown): ConfidentialSensitivity {
  if (typeof raw !== 'string') return DEFAULT_SENSITIVITY;
  const value = raw.trim().toLowerCase();
  return VALID_SENSITIVITIES.has(value)
    ? (value as ConfidentialSensitivity)
    : DEFAULT_SENSITIVITY;
}

function asEntries(raw: unknown): RawEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is RawEntry =>
      entry != null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asAliasList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const normalized = asNonEmptyString(entry);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function buildLiteralRule(
  kind: ConfidentialKind,
  entry: RawEntry,
  index: number,
): ConfidentialRule | null {
  const primary =
    asNonEmptyString(entry.name) ||
    asNonEmptyString(entry.label) ||
    asNonEmptyString(entry.term);
  if (!primary) return null;
  const aliases = asAliasList(entry.aliases);
  return {
    id: `${kind}_${String(index + 1).padStart(3, '0')}`,
    kind,
    label: primary,
    sensitivity: normalizeSensitivity(entry.sensitivity),
    literal: primary,
    literalAliases: aliases,
    caseInsensitive: true,
  };
}

function buildPatternRule(
  entry: RawEntry,
  index: number,
): ConfidentialRule | null {
  const label =
    asNonEmptyString(entry.name) || asNonEmptyString(entry.label) || null;
  const regexSource = asNonEmptyString(entry.regex);
  if (!label || !regexSource) return null;
  const caseInsensitive =
    entry.case_insensitive === true || entry.caseInsensitive === true;
  let regex: RegExp;
  try {
    regex = new RegExp(regexSource, caseInsensitive ? 'gi' : 'g');
  } catch {
    return null;
  }
  return {
    id: `pattern_${String(index + 1).padStart(3, '0')}`,
    kind: 'pattern',
    label,
    sensitivity: normalizeSensitivity(entry.sensitivity),
    regex,
    regexSource,
    caseInsensitive,
  };
}

function parseRuleSet(raw: RawConfig): ConfidentialRule[] {
  const rules: ConfidentialRule[] = [];

  const literalGroups: Array<[ConfidentialKind, unknown]> = [
    ['client', raw.clients],
    ['project', raw.projects],
    ['person', raw.people],
    ['keyword', raw.keywords],
  ];

  for (const [kind, entries] of literalGroups) {
    asEntries(entries).forEach((entry, index) => {
      const rule = buildLiteralRule(kind, entry, index);
      if (rule) rules.push(rule);
    });
  }

  asEntries(raw.patterns).forEach((entry, index) => {
    const rule = buildPatternRule(entry, index);
    if (rule) rules.push(rule);
  });

  return rules;
}

export function parseConfidentialYaml(
  source: string,
  sourcePath: string | null = null,
): ConfidentialRuleSet {
  const data = parseYaml(source) as unknown;
  const raw =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as RawConfig)
      : {};
  return { rules: parseRuleSet(raw), sourcePath };
}

/**
 * Search order, first hit wins:
 *   1. ./.confidential.yml (project-local, e.g. per-workspace overrides)
 *   2. ~/.hybridclaw/.confidential.yml (user-global default)
 */
export function defaultConfidentialConfigPaths(
  cwd: string = process.cwd(),
): string[] {
  return [
    path.join(cwd, CONFIDENTIAL_CONFIG_FILE),
    path.join(DEFAULT_RUNTIME_HOME_DIR, CONFIDENTIAL_CONFIG_FILE),
  ];
}

export function loadConfidentialRules(
  searchPaths?: string[],
): ConfidentialRuleSet {
  const candidates = searchPaths?.length
    ? searchPaths
    : defaultConfidentialConfigPaths();
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      return parseConfidentialYaml(raw, candidate);
    } catch (error) {
      console.warn(
        `[confidential] failed to load ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { rules: [], sourcePath: candidate };
    }
  }
  return { rules: [], sourcePath: null };
}

export function ruleHasContent(ruleSet: ConfidentialRuleSet): boolean {
  return ruleSet.rules.length > 0;
}
