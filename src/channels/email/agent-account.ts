/**
 * An agent's own mailbox: the one `email.accounts[]` entry that answers as
 * that agent, its password kept under a per-agent secret. The top-level
 * mailbox belongs to the email channel's agent (`agents.channels.email`).
 *
 * NOT the runtime (`runtime.ts` resolves and polls the accounts, and sends
 * for an agent without a mailbox from the default one); this only names the
 * secret, writes the entry and says whether an agent has a mailbox.
 */
import {
  type RuntimeConfig,
  type RuntimeEmailAccountConfig,
  type RuntimeEmailConfig,
  resolveChannelAgentId,
} from '../../config/runtime-config.js';

export function agentEmailPasswordSecretId(agentId: string): string {
  return `EMAIL_PASSWORD_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function findAgentEmailAccount(
  email: RuntimeEmailConfig,
  agentId: string,
): RuntimeEmailAccountConfig | undefined {
  return email.accounts.find((account) => account.agentId === agentId);
}

export function upsertAgentEmailAccount(
  email: RuntimeEmailConfig,
  account: RuntimeEmailAccountConfig,
): void {
  // An address answers as one agent, so setting it up for another moves it.
  const address = account.address.trim().toLowerCase();
  email.accounts = email.accounts.filter(
    (entry) =>
      entry.agentId === account.agentId ||
      entry.address.trim().toLowerCase() !== address,
  );
  const index = email.accounts.findIndex(
    (entry) => entry.agentId === account.agentId,
  );
  if (index >= 0) email.accounts[index] = account;
  else email.accounts.push(account);
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The address of the agent's own mailbox, or null when it has none and the
 * runtime sends and reads its mail through the default mailbox.
 */
export function resolveAgentOwnEmailAddress(
  config: Pick<RuntimeConfig, 'email' | 'agents'>,
  agentId: string,
): string | null {
  const { email } = config;
  if (!email.enabled) return null;
  const channelAgentId = resolveChannelAgentId('email', config);
  const own = email.accounts.find(
    (account) =>
      (account.agentId.trim() || channelAgentId) === agentId &&
      account.address.trim(),
  );
  if (own) return own.address.trim();
  const topLevel = email.address.trim();
  if (
    agentId === channelAgentId &&
    topLevel &&
    !email.accounts.some((account) => sameAddress(account.address, topLevel))
  ) {
    return topLevel;
  }
  return null;
}

/**
 * The address the agent's mail goes out from: its own mailbox, else the
 * default one the runtime falls back to, which is the first account
 * `resolveRuntimeConfig` in `runtime.ts` lists. The top-level mailbox comes
 * first unless an account replaces it.
 */
export function resolveAgentSenderEmailAddress(
  config: Pick<RuntimeConfig, 'email' | 'agents'>,
  agentId: string,
): { address: string; own: boolean } | null {
  const own = resolveAgentOwnEmailAddress(config, agentId);
  if (own) return { address: own, own: true };
  const { email } = config;
  if (!email.enabled) return null;
  const channelAgentId = resolveChannelAgentId('email', config);
  const topLevel = email.address.trim();
  const topLevelKept =
    topLevel &&
    !email.accounts.some(
      (account) =>
        (account.agentId.trim() || channelAgentId) === channelAgentId ||
        sameAddress(account.address, topLevel),
    );
  const address = topLevelKept
    ? topLevel
    : email.accounts[0]?.address.trim() || topLevel;
  return address ? { address, own: false } : null;
}
