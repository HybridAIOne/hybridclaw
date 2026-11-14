export type {
  NetworkPolicyAction,
  NetworkPolicyState,
  NetworkRule,
} from '@hybridclaw/shared/network-policy';

export {
  DEFAULT_NETWORK_DEFAULT,
  DEFAULT_NETWORK_RULES,
  doesNetworkHostPatternExpandToSubdomains,
  evaluateNetworkPolicyAccess,
  matchesNetworkAgentPattern,
  matchesNetworkHostPattern,
  matchesNetworkMethodPattern,
  matchesNetworkPathPatterns,
  normalizeNetworkAgent,
  normalizeNetworkHostScope,
  normalizeNetworkPathPattern,
  normalizeNetworkPort,
  normalizeNetworkRule,
  normalizePresetNames,
  readNetworkPolicyState,
} from '@hybridclaw/shared/network-policy';
