/**
 * Auth status for API-key providers and Slack: the lines both
 * `hybridclaw auth status <target>` and the in-chat `/auth status <target>`
 * show, built once so the terminal and chat reports cannot drift.
 *
 * Lines say whether a credential is configured and where it comes from, never
 * its value, and never name the secrets file: only the CLI prints that path.
 * NOT the target names (`auth-targets.ts`), and NOT the HybridAI, Codex,
 * local, and Teams reports, which the CLI and gateway build separately.
 */
import {
  getRuntimeConfig,
  runtimeConfigPath,
} from '../config/runtime-config.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import {
  GENERIC_PROVIDER_AUTH_DEFS,
  type GenericProviderAuthDef,
} from './generic-provider-auth.js';

export interface AuthStatusReport {
  title: string;
  lines: string[];
}

/**
 * The stored secret wins over the env, matching the precedence the runtime
 * reads credentials with (`readRuntimeSecretValue` in `config.ts`).
 */
export function resolveCredentialSource(
  secretKey: string,
  envVarNames: readonly string[],
): { configured: boolean; source: 'env' | 'runtime-secrets' | null } {
  const stored = readStoredRuntimeSecret(secretKey);
  const env = envVarNames.some((name) => process.env[name]?.trim());
  const source = stored ? 'runtime-secrets' : env ? 'env' : null;
  return { configured: source !== null, source };
}

interface ApiKeyStatusDef {
  configKey:
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | GenericProviderAuthDef['id'];
  label: string;
  secretKey: string;
  envVarNames: readonly string[];
  /**
   * Set where the model catalog is discovered; generic providers print a
   * `Provider:` line instead.
   */
  catalog?: 'auto-discovered';
}

function apiKeyStatusReport(def: ApiKeyStatusDef): () => AuthStatusReport {
  return () => {
    const config = getRuntimeConfig();
    const credential = resolveCredentialSource(def.secretKey, def.envVarNames);
    return {
      title: `${def.label} Auth Status`,
      lines: [
        ...(def.catalog ? [] : [`Provider: ${def.label}`]),
        `Authenticated: ${credential.configured ? 'yes' : 'no'}`,
        ...(credential.source ? [`Source: ${credential.source}`] : []),
        ...(credential.configured ? ['API key: configured'] : []),
        `Config: ${runtimeConfigPath()}`,
        `Enabled: ${config[def.configKey].enabled ? 'yes' : 'no'}`,
        `Base URL: ${config[def.configKey].baseUrl}`,
        `Default model: ${formatModelForDisplay(config.hybridai.defaultModel)}`,
        ...(def.catalog ? [`Catalog: ${def.catalog}`] : []),
      ],
    };
  };
}

function slackStatusReport(): AuthStatusReport {
  const config = getRuntimeConfig();
  const bot = resolveCredentialSource('SLACK_BOT_TOKEN', ['SLACK_BOT_TOKEN']);
  const app = resolveCredentialSource('SLACK_APP_TOKEN', ['SLACK_APP_TOKEN']);
  return {
    title: 'Slack Auth Status',
    lines: [
      `Authenticated: ${bot.configured && app.configured ? 'yes' : 'no'}`,
      ...(bot.source ? [`Bot token source: ${bot.source}`] : []),
      ...(app.source ? [`App token source: ${app.source}`] : []),
      ...(bot.configured ? ['Bot token: configured'] : []),
      ...(app.configured ? ['App token: configured'] : []),
      `Config: ${runtimeConfigPath()}`,
      `Enabled: ${config.slack.enabled ? 'yes' : 'no'}`,
      `DM policy: ${config.slack.dmPolicy}`,
      `Group policy: ${config.slack.groupPolicy}`,
      `Require mention: ${config.slack.requireMention ? 'yes' : 'no'}`,
      `Reply style: ${config.slack.replyStyle}`,
    ],
  };
}

const SHARED_AUTH_STATUS_REPORTS = {
  openrouter: apiKeyStatusReport({
    configKey: 'openrouter',
    label: 'OpenRouter',
    secretKey: 'OPENROUTER_API_KEY',
    envVarNames: ['OPENROUTER_API_KEY'],
    catalog: 'auto-discovered',
  }),
  mistral: apiKeyStatusReport({
    configKey: 'mistral',
    label: 'Mistral',
    secretKey: 'MISTRAL_API_KEY',
    envVarNames: ['MISTRAL_API_KEY'],
    catalog: 'auto-discovered',
  }),
  huggingface: apiKeyStatusReport({
    configKey: 'huggingface',
    label: 'Hugging Face',
    secretKey: 'HF_TOKEN',
    envVarNames: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    catalog: 'auto-discovered',
  }),
  ...(Object.fromEntries(
    GENERIC_PROVIDER_AUTH_DEFS.map((def) => [
      def.id,
      apiKeyStatusReport({ ...def, configKey: def.id }),
    ]),
  ) as Record<GenericProviderAuthDef['id'], () => AuthStatusReport>),
  slack: slackStatusReport,
};

export type SharedAuthStatusTarget = keyof typeof SHARED_AUTH_STATUS_REPORTS;

export function isSharedAuthStatusTarget(
  target: string,
): target is SharedAuthStatusTarget {
  return Object.hasOwn(SHARED_AUTH_STATUS_REPORTS, target);
}

export function buildSharedAuthStatusReport(
  target: SharedAuthStatusTarget,
): AuthStatusReport {
  return SHARED_AUTH_STATUS_REPORTS[target]();
}
