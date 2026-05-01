import {
  type ConfidentialFinding,
  dehydrateConfidential,
  scanForLeaks,
} from '../security/confidential-redact.js';
import type { ConfidentialRuleSet } from '../security/confidential-rules.js';
import type {
  AgentTurnContext,
  ClassifierMiddlewareSkill,
} from './middleware.js';

function summarizeSafeFindings(
  findings: readonly ConfidentialFinding[],
): string {
  if (findings.length === 0) return 'confidential content';
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.sensitivity} ${finding.kind}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${count} ${key} rule${count === 1 ? '' : 's'}`)
    .join(', ');
}

export function createConfidentialLeakMiddlewareSkill(
  ruleSet: ConfidentialRuleSet | null | undefined,
): ClassifierMiddlewareSkill<AgentTurnContext> | null {
  if (!ruleSet || ruleSet.rules.length === 0) return null;

  return {
    id: 'confidential-leak',
    priority: 0,
    post_receive(context) {
      const text = context.resultText || '';
      const scan = scanForLeaks(text, ruleSet);
      if (scan.totalMatches === 0) return { action: 'allow' };

      const reason = `Confidential output matched ${summarizeSafeFindings(scan.findings)} (${scan.severity}, ${scan.totalMatches} match${scan.totalMatches === 1 ? '' : 'es'}).`;
      if (scan.severity === 'critical') {
        return {
          action: 'escalate',
          route: 'security',
          reason,
        };
      }
      if (scan.severity === 'high') {
        return {
          action: 'block',
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
