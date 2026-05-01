import {
  dehydrateConfidential,
  scanForLeaks,
} from '../security/confidential-redact.js';
import type { ConfidentialRuleSet } from '../security/confidential-rules.js';
import type { ClassifierMiddlewareSkill } from './middleware.js';

function summarizeFindings(labels: readonly string[]): string {
  if (labels.length === 0) return 'confidential content';
  if (labels.length <= 3) return labels.join(', ');
  return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`;
}

export function createConfidentialLeakMiddlewareSkill(
  ruleSet: ConfidentialRuleSet | null | undefined,
): ClassifierMiddlewareSkill | null {
  if (!ruleSet || ruleSet.rules.length === 0) return null;

  return {
    id: 'confidential-leak',
    priority: 0,
    post_receive(context) {
      const text = context.resultText || '';
      const scan = scanForLeaks(text, ruleSet);
      if (scan.totalMatches === 0) return { action: 'allow' };

      const labels = [
        ...new Set(scan.findings.map((finding) => finding.label)),
      ];
      const reason = `Confidential output matched ${summarizeFindings(labels)} (${scan.severity}, ${scan.totalMatches} match${scan.totalMatches === 1 ? '' : 'es'}).`;
      if (scan.severity === 'critical') {
        return {
          action: 'escalate',
          route: 'security',
          reason,
        };
      }

      return {
        action: 'transform',
        payload: dehydrateConfidential(text, ruleSet).text,
        reason,
      };
    },
  };
}
