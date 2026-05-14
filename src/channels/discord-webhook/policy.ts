import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  type ManagedNetworkRule,
  readPolicyState,
  setPolicyPresets,
  stripRuleIndex,
} from '../../policy/policy-store.js';
import { normalizeDiscordWebhookUrl } from './target.js';

export const DISCORD_WEBHOOK_POLICY_PRESET = 'discord_webhook';

function discordWebhookPolicyRuleForHost(host: string): ManagedNetworkRule {
  return {
    action: 'allow',
    host,
    port: 443,
    methods: ['POST'],
    paths: ['/api/webhooks/**'],
    agent: DEFAULT_AGENT_ID,
    comment: 'Allow outbound Discord Incoming Webhook delivery.',
    managedByPreset: DISCORD_WEBHOOK_POLICY_PRESET,
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

export function allowDiscordWebhookInWorkspacePolicy(params: {
  webhookUrl: string;
  workspacePath: string;
}): {
  policyPath: string;
  added: boolean;
  rule: ManagedNetworkRule;
} {
  const normalizedUrl = normalizeDiscordWebhookUrl(
    params.webhookUrl,
    'discordWebhook.webhook_url',
  );
  const host = new URL(normalizedUrl).hostname;
  const rule = discordWebhookPolicyRuleForHost(host);
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
    presets: [...new Set([...state.presets, DISCORD_WEBHOOK_POLICY_PRESET])],
    rules: [...existingRules, rule],
  });
  return {
    policyPath: nextState.policyPath,
    added: true,
    rule,
  };
}
