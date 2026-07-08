import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '../security/api-tokens.js';
import { normalizeArgs, parseValueFlag } from './common.js';
import { isHelpRequest, printTokenUsage } from './help.js';

function splitClaimList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatTokenStatus(token: {
  revoked_at: string | null;
  expires_at: string | null;
}) {
  if (token.revoked_at) return 'revoked';
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
    return 'expired';
  }
  return 'active';
}

function formatClaims(claims: Record<string, unknown>): string {
  const entries = Object.entries(claims)
    .map(
      ([key, value]) =>
        `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`,
    )
    .join(' ');
  return entries || 'actions=';
}

function parseCreateArgs(args: string[]): {
  label: string;
  claims: Record<string, unknown>;
  expiresAt: string | null;
} {
  let label = '';
  let role = '';
  let actions: string[] = [];
  let expiresAt: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    const labelFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--label',
      placeholder: '<label>',
    });
    if (labelFlag) {
      label = labelFlag.value;
      index = labelFlag.nextIndex;
      continue;
    }
    const roleFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--role',
      placeholder: '<role>',
    });
    if (roleFlag) {
      role = roleFlag.value;
      index = roleFlag.nextIndex;
      continue;
    }
    const actionsFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--actions',
      placeholder: '<action[,action]>',
    });
    if (actionsFlag) {
      actions = splitClaimList(actionsFlag.value);
      index = actionsFlag.nextIndex;
      continue;
    }
    const expiresAtFlag = parseValueFlag({
      arg,
      args,
      index,
      name: '--expires-at',
      placeholder: '<iso>',
    });
    if (expiresAtFlag) {
      expiresAt = expiresAtFlag.value;
      index = expiresAtFlag.nextIndex;
      continue;
    }
    throw new Error(`Unknown token create argument: ${arg}`);
  }

  if (!label) {
    throw new Error(
      'Usage: `hybridclaw token create --label <label> (--role <role>|--actions <a,b>)`',
    );
  }
  if (!role && actions.length === 0) {
    throw new Error('Token claims are required. Pass `--role` or `--actions`.');
  }

  return {
    label,
    claims: {
      ...(role ? { role } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    },
    expiresAt,
  };
}

export async function handleTokenCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printTokenUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();

  if (sub === 'list') {
    const tokens = listApiTokens();
    if (tokens.length === 0) {
      console.log('(none)');
      return;
    }
    for (const token of tokens) {
      console.log(
        [
          token.id,
          formatTokenStatus(token),
          token.label,
          `created=${token.created_at}`,
          `expires=${token.expires_at || 'never'}`,
          `last_used=${token.last_used_at || 'never'}`,
          formatClaims(token.claims),
        ].join('\t'),
      );
    }
    return;
  }

  if (sub === 'create') {
    const parsed = parseCreateArgs(normalized.slice(1));
    const result = createApiToken({
      label: parsed.label,
      claims: parsed.claims,
      expiresAt: parsed.expiresAt,
      createdBy: 'cli',
    });
    console.log(
      `Created API token ${result.metadata.id} (${result.metadata.label}).`,
    );
    console.log(`Token: ${result.token}`);
    console.log('Store it now. HybridClaw cannot show this token again.');
    return;
  }

  if (sub === 'revoke') {
    const id = String(normalized[1] || '').trim();
    if (!id) {
      throw new Error('Usage: `hybridclaw token revoke <id>`');
    }
    const token = revokeApiToken(id);
    if (!token) {
      throw new Error(`API token not found: ${id}`);
    }
    console.log(`Revoked API token ${token.id} (${token.label}).`);
    return;
  }

  throw new Error(`Unknown token subcommand: ${sub}`);
}
