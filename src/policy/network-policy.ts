export type {
  NetworkPolicyAction,
  NetworkPolicyState,
  NetworkRule,
} from '#shared/network-policy.js';

export {
  asRecord,
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
} from '#shared/network-policy.js';
