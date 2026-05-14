import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  type ManagedNetworkRule,
  readPolicyState,
  setPolicyPresets,
  stripRuleIndex,
} from '../../policy/policy-store.js';
import { normalizeSlackWebhookUrl } from './target.js';

export const SLACK_WEBHOOK_POLICY_PRESET = 'slack_webhook';

function slackWebhookPolicyRuleForHost(host: string): ManagedNetworkRule {
  return {
    action: 'allow',
    host,
    port: 443,
    methods: ['POST'],
    paths: ['/services/**'],
    agent: DEFAULT_AGENT_ID,
    comment: 'Allow outbound Slack Incoming Webhook delivery.',
    managedByPreset: SLACK_WEBHOOK_POLICY_PRESET,
  };
}

function ruleKey(rule: ManagedNetworkRule): string {
  return [
    rule.action,
    rule.host,
    String(rule.port),
    rule.methods.join(','),
    rule.paths.join(','),
    rule.agent,
    rule.managedByPreset || '',
  ].join('|');
}

export function allowSlackWebhookInWorkspacePolicy(params: {
  webhookUrl: string;
  workspacePath: string;
}): {
  policyPath: string;
  added: boolean;
  rule: ManagedNetworkRule;
} {
  const normalizedUrl = normalizeSlackWebhookUrl(
    params.webhookUrl,
    'slackWebhook.webhook_url',
  );
  const host = new URL(normalizedUrl).hostname;
  const rule = slackWebhookPolicyRuleForHost(host);
  const state = readPolicyState(params.workspacePath);
  const targetKey = ruleKey(rule);
  const existingRules = state.rules.map((entry) => ({
    ...stripRuleIndex(entry),
    ...(entry.managedByPreset
      ? { managedByPreset: entry.managedByPreset }
      : {}),
  }));

  if (existingRules.some((entry) => ruleKey(entry) === targetKey)) {
    return {
      policyPath: state.policyPath,
      added: false,
      rule,
    };
  }

  const nextState = setPolicyPresets(params.workspacePath, {
    presets: [...new Set([...state.presets, SLACK_WEBHOOK_POLICY_PRESET])],
    rules: [...existingRules, rule],
  });
  return {
    policyPath: nextState.policyPath,
    added: true,
    rule,
  };
}
