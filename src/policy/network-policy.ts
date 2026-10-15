export type {
  NetworkPolicyAction,
  NetworkPolicyState,
  NetworkRule,
} from '../../container/shared/network-policy.js';

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
} from '../../container/shared/network-policy.js';
