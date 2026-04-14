export type {
  NetworkPolicyAction,
  NetworkPolicyState,
  NetworkRule,
} from '../../container/shared/network-policy.js';

export {
  asRecord,
  DEFAULT_NETWORK_DEFAULT,
  DEFAULT_NETWORK_RULES,
  doesNetworkHostPatternExpandToSubdomains,
  normalizeNetworkAgent,
  normalizeNetworkHostScope,
  normalizeNetworkPathPattern,
  normalizeNetworkPort,
  normalizeNetworkRule,
  normalizePresetNames,
  readNetworkPolicyState,
} from '../../container/shared/network-policy.js';
