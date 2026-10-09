import { getConfigSnapshot } from '../../config/config.js';
import { resolveDefaultAgentId } from '../../config/runtime-config.js';

/**
 * The address the email channel sends from for an agent, picked the way the
 * email runtime picks its send account: the agent's own account, else the
 * first one. Only addresses are read; a broken account is the runtime's error.
 */
export function resolveEmailSenderAddress(
  agentId?: string,
): string | undefined {
  const config = getConfigSnapshot().email;
  if (!config.enabled) return undefined;
  const defaultAgentId = resolveDefaultAgentId();
  const accounts = config.accounts
    .map((account) => ({
      address: account.address.trim(),
      agentId: String(account.agentId || '').trim() || defaultAgentId,
    }))
    .filter((account) => account.address);
  const legacyAddress = config.address.trim();
  if (
    legacyAddress &&
    !accounts.some(
      (account) =>
        account.agentId === defaultAgentId ||
        account.address.toLowerCase() === legacyAddress.toLowerCase(),
    )
  ) {
    accounts.unshift({ address: legacyAddress, agentId: defaultAgentId });
  }
  const wanted = String(agentId || '').trim();
  return (
    (wanted && accounts.find((account) => account.agentId === wanted)) ||
    accounts[0]
  )?.address;
}
