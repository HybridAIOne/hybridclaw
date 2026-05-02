import {
  getRuntimeConfig,
  isGoogleApisUrlPrefix,
  isGoogleOAuthSecretRef,
  isGoogleOAuthSpecifier,
  makeGoogleOAuthSecretRef,
  type RuntimeHttpRequestAuthRule,
  type RuntimeHttpRequestAuthRuleSecret,
  runtimeConfigPath,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  allowHttpSecretRouteInWorkspacePolicy,
  captureHttpSecretRoutePolicySnapshot,
  removeHttpSecretRouteFromWorkspacePolicy,
  restoreHttpSecretRoutePolicySnapshot,
} from '../policy/secret-route-policy.js';
import {
  isReservedNonSecretRuntimeName,
  isRuntimeSecretName,
  listStoredRuntimeSecretNames,
  readStoredRuntimeSecret,
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import { normalizeArgs } from './common.js';
import { isHelpRequest, printSecretUsage } from './help.js';

function normalizeUrlPrefix(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('URL prefix is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL prefix: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL prefix protocol: ${parsed.protocol}`);
  }

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const pathname = parsed.pathname || '/';
  parsed.pathname = `${pathname.replace(/\/+$/, '') || ''}/`;
  return parsed.toString();
}

function normalizeSecretRouteHeader(raw: string | undefined): string {
  const header = String(raw || 'Authorization').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header)) {
    throw new Error(`Invalid header name: ${header}`);
  }
  return header;
}

function normalizeSecretRoutePrefix(raw: string | undefined): string {
  const normalized = String(raw || 'Bearer').trim();
  if (!normalized || normalized.toLowerCase() === 'none') {
    return '';
  }
  return normalized;
}

function normalizeSecretRouteSecret(
  raw: string,
): RuntimeHttpRequestAuthRuleSecret {
  const value = String(raw || '').trim();
  if (isGoogleOAuthSpecifier(value)) {
    return makeGoogleOAuthSecretRef();
  }
  assertSecretName(value);
  return { source: 'store', id: value };
}

function formatRouteSecretLabel(
  secret: RuntimeHttpRequestAuthRuleSecret,
): string {
  if (typeof secret === 'string') return secret;
  if (isGoogleOAuthSecretRef(secret)) return 'google-oauth';
  return `${secret.source}:${secret.id}`;
}

function formatHttpRequestAuthRule(
  rule: RuntimeHttpRequestAuthRule,
  index: number,
): string {
  const parsedSecret =
    typeof rule.secret === 'string'
      ? rule.secret
      : isGoogleOAuthSecretRef(rule.secret)
        ? 'google-oauth'
        : typeof rule.secret.id === 'string'
          ? `${rule.secret.source}:${rule.secret.id}`
          : '<invalid>';
  const prefix = rule.prefix ? ` ${rule.prefix}` : '';
  return `${index + 1}. ${rule.urlPrefix} -> ${rule.header}:${prefix} ${parsedSecret}`.trim();
}

function assertSecretName(secretName: string): void {
  if (!isRuntimeSecretName(secretName)) {
    throw new Error(
      'Secret names must use uppercase letters, digits, and underscores only.',
    );
  }
  if (isReservedNonSecretRuntimeName(secretName)) {
    throw new Error(
      `\`${secretName}\` is a normal runtime config key and cannot be stored in encrypted secrets.`,
    );
  }
}

export async function handleSecretCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printSecretUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();

  if (sub === 'list') {
    const config = getRuntimeConfig();
    const secretNames = listStoredRuntimeSecretNames();
    const rules = config.tools.httpRequest.authRules;
    console.log(`Encrypted store: ${runtimeSecretsPath()}`);
    console.log(
      `Secrets: ${secretNames.length > 0 ? secretNames.join(', ') : '(none)'}`,
    );
    console.log('');
    console.log('HTTP auth routes:');
    if (rules.length === 0) {
      console.log('(none)');
      return;
    }
    for (const [index, rule] of rules.entries()) {
      console.log(formatHttpRequestAuthRule(rule, index));
    }
    return;
  }

  if (sub === 'set') {
    const secretName = String(normalized[1] || '').trim();
    const secretValue = normalized.slice(2).join(' ').trim();
    if (!secretName || !secretValue) {
      printSecretUsage();
      throw new Error('Usage: `hybridclaw secret set <name> <value>`');
    }
    assertSecretName(secretName);
    saveNamedRuntimeSecrets({ [secretName]: secretValue });
    console.log(
      `Stored encrypted secret \`${secretName}\` in \`${runtimeSecretsPath()}\`.`,
    );
    return;
  }

  if (sub === 'unset' || sub === 'delete' || sub === 'remove') {
    const secretName = String(normalized[1] || '').trim();
    if (!secretName) {
      printSecretUsage();
      throw new Error('Usage: `hybridclaw secret unset <name>`');
    }
    assertSecretName(secretName);
    saveNamedRuntimeSecrets({ [secretName]: null });
    console.log(`Removed encrypted secret \`${secretName}\`.`);
    return;
  }

  if (sub === 'show' || sub === 'status') {
    const secretName = String(normalized[1] || '').trim();
    if (!secretName) {
      printSecretUsage();
      throw new Error('Usage: `hybridclaw secret show <name>`');
    }
    assertSecretName(secretName);
    const stored = readStoredRuntimeSecret(secretName);
    console.log(`Name: ${secretName}`);
    console.log(`Stored: ${stored ? 'yes' : 'no'}`);
    console.log(`Path: ${runtimeSecretsPath()}`);
    return;
  }

  if (sub === 'route') {
    const action = (normalized[1] || '').trim().toLowerCase();
    if (!action || action === 'list') {
      const rules = getRuntimeConfig().tools.httpRequest.authRules;
      if (rules.length === 0) {
        console.log('(none)');
        return;
      }
      for (const [index, rule] of rules.entries()) {
        console.log(formatHttpRequestAuthRule(rule, index));
      }
      return;
    }

    if (action === 'add') {
      const rawPrefix = String(normalized[2] || '').trim();
      const secretName = String(normalized[3] || '').trim();
      const rawHeader = String(normalized[4] || '').trim();
      const rawAuthPrefix = String(normalized[5] || '').trim();
      if (!rawPrefix || !secretName) {
        printSecretUsage();
        throw new Error(
          'Usage: `hybridclaw secret route add <url-prefix> <secret-name|google-oauth> [header] [prefix|none]`',
        );
      }
      const secret = normalizeSecretRouteSecret(secretName);
      const urlPrefix = normalizeUrlPrefix(rawPrefix);
      if (isGoogleOAuthSecretRef(secret) && !isGoogleApisUrlPrefix(urlPrefix)) {
        throw new Error(
          '`google-oauth` routes can only target googleapis.com or *.googleapis.com URL prefixes.',
        );
      }
      const header = normalizeSecretRouteHeader(rawHeader);
      const prefix = normalizeSecretRoutePrefix(rawAuthPrefix);
      const policyWorkspacePath = agentWorkspaceDir(DEFAULT_AGENT_ID);
      const policySnapshot =
        captureHttpSecretRoutePolicySnapshot(policyWorkspacePath);
      const policyRuleId = allowHttpSecretRouteInWorkspacePolicy({
        workspacePath: policyWorkspacePath,
        urlPrefix,
        header,
        secret,
        agentId: DEFAULT_AGENT_ID,
      });
      try {
        updateRuntimeConfig(
          (draft) => {
            const nextRule: RuntimeHttpRequestAuthRule = {
              urlPrefix,
              header,
              prefix,
              secret,
            };
            draft.tools.httpRequest.authRules =
              draft.tools.httpRequest.authRules.filter(
                (rule) =>
                  !(
                    rule.urlPrefix === urlPrefix &&
                    rule.header.toLowerCase() === header.toLowerCase()
                  ),
              );
            draft.tools.httpRequest.authRules.push(nextRule);
          },
          {
            route: `cli.secret.route.add:${urlPrefix}:${header}`,
            source: 'internal',
          },
        );
      } catch (error) {
        restoreHttpSecretRoutePolicySnapshot(policySnapshot);
        throw error;
      }
      const authLabel = prefix
        ? `${header}: ${prefix} <secret>`
        : `${header}: <secret>`;
      console.log(
        `Added secret route for \`${urlPrefix}\` using \`${formatRouteSecretLabel(secret)}\` as \`${authLabel}\`.`,
      );
      console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
      if (policyRuleId) {
        console.log(`Allowed this route in secret policy rule \`${policyRuleId}\`.`);
      }
      return;
    }

    if (action === 'remove') {
      const rawPrefix = String(normalized[2] || '').trim();
      const rawHeader = String(normalized[3] || '').trim();
      if (!rawPrefix) {
        printSecretUsage();
        throw new Error(
          'Usage: `hybridclaw secret route remove <url-prefix> [header]`',
        );
      }
      const urlPrefix = normalizeUrlPrefix(rawPrefix);
      const header = rawHeader ? normalizeSecretRouteHeader(rawHeader) : '';
      const currentRules = getRuntimeConfig().tools.httpRequest.authRules.filter(
        (rule) => {
          if (rule.urlPrefix !== urlPrefix) return false;
          if (header && rule.header.toLowerCase() !== header.toLowerCase()) {
            return false;
          }
          return true;
        },
      );
      const policyWorkspacePath = agentWorkspaceDir(DEFAULT_AGENT_ID);
      const policySnapshot =
        captureHttpSecretRoutePolicySnapshot(policyWorkspacePath);
      for (const rule of currentRules) {
        removeHttpSecretRouteFromWorkspacePolicy({
          workspacePath: policyWorkspacePath,
          urlPrefix,
          header: rule.header,
          agentId: DEFAULT_AGENT_ID,
        });
      }
      let removed = 0;
      try {
        updateRuntimeConfig(
          (draft) => {
            const before = draft.tools.httpRequest.authRules.length;
            draft.tools.httpRequest.authRules =
              draft.tools.httpRequest.authRules.filter((rule) => {
                if (rule.urlPrefix !== urlPrefix) return true;
                if (
                  header &&
                  rule.header.toLowerCase() !== header.toLowerCase()
                ) {
                  return true;
                }
                return false;
              });
            removed = before - draft.tools.httpRequest.authRules.length;
          },
          {
            route: `cli.secret.route.remove:${urlPrefix}:${header || '*'}`,
            source: 'internal',
          },
        );
      } catch (error) {
        restoreHttpSecretRoutePolicySnapshot(policySnapshot);
        throw error;
      }
      console.log(
        removed > 0
          ? `Removed ${removed} secret route${removed === 1 ? '' : 's'} for \`${urlPrefix}\`.`
          : `No secret routes matched \`${urlPrefix}\`.`,
      );
      if (removed > 0) {
        console.log(`Updated runtime config at ${runtimeConfigPath()}.`);
      }
      return;
    }

    printSecretUsage();
    throw new Error(
      'Usage: `hybridclaw secret route list`, `hybridclaw secret route add <url-prefix> <secret-name|google-oauth> [header] [prefix|none]`, or `hybridclaw secret route remove <url-prefix> [header]`',
    );
  }

  printSecretUsage();
  throw new Error(
    'Unknown secret subcommand. Use `hybridclaw secret list|set|show|unset|route`.',
  );
}
