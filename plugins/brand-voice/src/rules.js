export function detectRuleViolations(text, config) {
  const violations = [];
  const lowered = text.toLowerCase();
  for (const phrase of config.bannedPhrases) {
    if (!phrase) continue;
    if (lowered.includes(phrase)) {
      violations.push({ kind: 'banned_phrase', detail: phrase });
    }
  }
  for (let index = 0; index < config.bannedPatterns.length; index++) {
    const pattern = config.bannedPatterns[index];
    if (!pattern) continue;
    if (pattern.test(text)) {
      violations.push({
        kind: 'banned_pattern',
        detail: config.bannedPatternStrings[index] || pattern.source,
      });
    }
  }
  for (const required of config.requirePhrases) {
    if (!required) continue;
    if (!lowered.includes(required.toLowerCase())) {
      violations.push({ kind: 'missing_required', detail: required });
    }
  }
  return violations;
}

export function summarizeViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '';
  const grouped = new Map();
  for (const violation of violations) {
    const key = violation.kind;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(violation.detail);
  }
  const out = [];
  for (const [kind, details] of grouped.entries()) {
    if (kind === 'banned_phrase') {
      out.push(`banned phrases: ${details.map((d) => `"${d}"`).join(', ')}`);
    } else if (kind === 'banned_pattern') {
      out.push(`banned patterns: ${details.join(', ')}`);
    } else if (kind === 'missing_required') {
      out.push(
        `missing required phrases: ${details.map((d) => `"${d}"`).join(', ')}`,
      );
    } else {
      out.push(`${kind}: ${details.join(', ')}`);
    }
  }
  return out.join('; ');
}
