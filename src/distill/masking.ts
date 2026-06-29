import {
  createPlaceholderMap,
  dehydrateConfidential,
} from '../security/confidential-redact.js';
import type { ConfidentialRuleSet } from '../security/confidential-rules.js';
import {
  loadConfidentialRules,
  ruleHasContent,
} from '../security/confidential-rules.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /(?<![\w/.-])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w/.-])/g;

export interface ThirdPartyMaskResult {
  text: string;
  maskedCount: number;
}

let cachedRuleSet: ConfidentialRuleSet | null | undefined;

export function loadDistillConfidentialRules(): ConfidentialRuleSet | null {
  if (cachedRuleSet !== undefined) return cachedRuleSet;
  try {
    const ruleSet = loadConfidentialRules();
    cachedRuleSet = ruleHasContent(ruleSet) ? ruleSet : null;
  } catch {
    cachedRuleSet = null;
  }
  return cachedRuleSet;
}

export function resetDistillConfidentialRulesCache(): void {
  cachedRuleSet = undefined;
}

/**
 * R4 masking on ingest: third-party PII in source material is masked before
 * it ever lands in the corpus. Subject-owned identifiers are kept so the
 * subject stays attributable; everyone else's contact details are not the
 * subject's to donate. Operator-defined confidential rules
 * (`.confidential.yml`) are applied irreversibly — the placeholder mapping is
 * deliberately discarded.
 */
export function maskThirdPartyPii(
  text: string,
  subjectAliases: string[],
  ruleSet: ConfidentialRuleSet | null = loadDistillConfidentialRules(),
): ThirdPartyMaskResult {
  const aliases = subjectAliases.map((alias) => alias.toLowerCase());
  let maskedCount = 0;

  let masked = text.replace(EMAIL_RE, (email) => {
    const lower = email.toLowerCase();
    const localPart = lower.split('@')[0];
    const isSubject = aliases.some(
      (alias) =>
        alias === lower || alias === localPart || alias.includes(lower),
    );
    if (isSubject) return email;
    maskedCount += 1;
    return '[third-party-email]';
  });

  masked = masked.replace(PHONE_RE, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return candidate;
    maskedCount += 1;
    return '[phone]';
  });

  if (ruleSet) {
    const result = dehydrateConfidential(
      masked,
      ruleSet,
      createPlaceholderMap(),
    );
    if (result.hits > 0) {
      masked = result.text;
      maskedCount += result.hits;
    }
  }

  return { text: masked, maskedCount };
}
