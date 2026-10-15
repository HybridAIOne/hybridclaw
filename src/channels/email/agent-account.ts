/**
 * An agent's own mailbox: the one `email.accounts[]` entry that answers as
 * that agent, its password kept under a per-agent secret. The top-level
 * mailbox belongs to the email channel's agent (`agents.channels.email`).
 *
 * NOT the runtime (`runtime.ts` resolves and polls the accounts); this only
 * names the secret and writes the entry.
 */
import type {
  RuntimeEmailAccountConfig,
  RuntimeEmailConfig,
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
