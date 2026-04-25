import { describe, expect, test } from 'vitest';

import {
  createPlaceholderMap,
  dehydrateConfidential,
  rehydrateConfidential,
  scanForLeaks,
} from '../src/security/confidential-redact.js';
import { parseConfidentialYaml } from '../src/security/confidential-rules.js';

const RULES_YAML = `
version: 1
clients:
  - name: Serviceplan
    aliases: [SP, "Serviceplan AG"]
    sensitivity: high
  - name: Acme
    sensitivity: medium
projects:
  - name: Project Falcon
    sensitivity: critical
people:
  - name: Jane Doe
    sensitivity: medium
keywords:
  - term: "Q4 2026 budget"
    sensitivity: critical
patterns:
  - name: internal-doc
    regex: "INT-\\\\d{6}"
    sensitivity: high
`;

const ruleSet = parseConfidentialYaml(RULES_YAML, 'memory:test');

describe('confidential rules loader', () => {
  test('parses literal entries and patterns', () => {
    const labels = ruleSet.rules.map((rule) => rule.label).sort();
    expect(labels).toContain('Serviceplan');
    expect(labels).toContain('Acme');
    expect(labels).toContain('Project Falcon');
    expect(labels).toContain('Jane Doe');
    expect(labels).toContain('Q4 2026 budget');
    expect(labels).toContain('internal-doc');
  });

  test('aliases are tracked alongside primary literal', () => {
    const sp = ruleSet.rules.find((rule) => rule.label === 'Serviceplan');
    expect(sp?.literalAliases).toEqual(['SP', 'Serviceplan AG']);
  });

  test('returns empty rule set when YAML is empty', () => {
    expect(parseConfidentialYaml('').rules).toEqual([]);
  });
});

describe('dehydrate / rehydrate', () => {
  test('replaces literal hits with stable placeholders', () => {
    const text =
      'Serviceplan briefed us on Project Falcon. SP wants the Q4 2026 budget by Friday.';
    const {
      text: dehydrated,
      mappings,
      hits,
    } = dehydrateConfidential(text, ruleSet);
    expect(hits).toBeGreaterThanOrEqual(4);
    expect(dehydrated).not.toMatch(/Serviceplan/);
    expect(dehydrated).not.toMatch(/Project Falcon/);
    expect(dehydrated).not.toMatch(/Q4 2026 budget/);

    const rehydrated = rehydrateConfidential(dehydrated, mappings);
    // Aliases collapse to the primary spelling on rehydrate (last-write-wins
    // through the placeholder); the canonical name remains intact.
    expect(rehydrated).toContain('Serviceplan');
    expect(rehydrated).toContain('Project Falcon');
    expect(rehydrated).toContain('Q4 2026 budget');
  });

  test('placeholders are stable across calls when reusing mappings', () => {
    const mappings = createPlaceholderMap();
    const first = dehydrateConfidential('Serviceplan again', ruleSet, mappings);
    const second = dehydrateConfidential(
      'Serviceplan again',
      ruleSet,
      mappings,
    );
    expect(first.text).toBe(second.text);
  });

  test('regex patterns are matched and rehydrated', () => {
    const text = 'See doc INT-123456 attached.';
    const {
      text: dehydrated,
      mappings,
      hits,
    } = dehydrateConfidential(text, ruleSet);
    expect(hits).toBe(1);
    expect(dehydrated).not.toContain('INT-123456');
    expect(rehydrateConfidential(dehydrated, mappings)).toContain('INT-123456');
  });

  test('case-insensitive literal matching', () => {
    const { hits } = dehydrateConfidential('SERVICEPLAN told ACME', ruleSet);
    expect(hits).toBe(2);
  });

  test('no-op when rule set is empty', () => {
    const empty = parseConfidentialYaml('');
    const { text, hits } = dehydrateConfidential('Hello Serviceplan', empty);
    expect(text).toBe('Hello Serviceplan');
    expect(hits).toBe(0);
  });

  test('rehydrate with unknown placeholder is left intact', () => {
    const out = rehydrateConfidential(
      'See «CONF:UNKNOWN_001» here.',
      createPlaceholderMap(),
    );
    expect(out).toBe('See «CONF:UNKNOWN_001» here.');
  });
});

describe('scanForLeaks', () => {
  test('flags multiple sensitivities and produces a non-zero score', () => {
    const text =
      'Serviceplan brief: Project Falcon launches Q4 2026 budget review with INT-654321.';
    const result = scanForLeaks(text, ruleSet);
    expect(result.totalMatches).toBeGreaterThanOrEqual(4);
    expect(result.score).toBeGreaterThan(0);
    expect(['high', 'critical']).toContain(result.severity);
    const labels = result.findings.map((finding) => finding.label);
    expect(labels).toContain('Project Falcon');
    expect(labels).toContain('Q4 2026 budget');
    expect(labels).toContain('Serviceplan');
    // Findings sorted critical/high first.
    expect(result.findings[0]?.sensitivity).toBe('critical');
  });

  test('returns zero score for clean text', () => {
    const result = scanForLeaks('All quiet here.', ruleSet);
    expect(result.totalMatches).toBe(0);
    expect(result.score).toBe(0);
    expect(result.severity).toBe('low');
  });

  test('caps raw score at 1000', () => {
    const text = Array(50).fill('Project Falcon').join(' ');
    const result = scanForLeaks(text, ruleSet);
    expect(result.rawScore).toBeLessThanOrEqual(1000);
    expect(result.score).toBe(100);
    expect(result.severity).toBe('critical');
  });

  test('excerpt is short and includes redaction marker', () => {
    const result = scanForLeaks('Notes: Serviceplan brief follows.', ruleSet);
    const finding = result.findings.find(
      (entry) => entry.label === 'Serviceplan',
    );
    expect(finding?.excerpt).toContain('***');
    expect(finding?.excerpt.length).toBeLessThan(180);
  });
});
