export type NetworkPolicyAction = 'allow' | 'deny';

export interface NetworkRule {
  action: NetworkPolicyAction;
  host: string;
  port: number;
  methods: string[];
  paths: string[];
  agent: string;
  comment?: string;
}

export interface NetworkRuleInput {
  action?: unknown;
  host?: unknown;
  port?: unknown;
  methods?: unknown;
  paths?: unknown;
  agent?: unknown;
  comment?: unknown;
}

export interface NetworkPolicyState {
  defaultAction: NetworkPolicyAction;
  rules: NetworkRule[];
  presets: string[];
}

export const DEFAULT_NETWORK_DEFAULT: NetworkPolicyAction;
export const DEFAULT_NETWORK_RULES: NetworkRule[];

export function normalizeNetworkPathPattern(rawPath: unknown): string;
export function normalizeNetworkAgent(raw: unknown): string;
export function normalizeNetworkPort(raw: unknown): number;
export function normalizeNetworkRule(raw: NetworkRuleInput): NetworkRule | null;
export function readNetworkPolicyState(
  document: Record<string, unknown>,
): NetworkPolicyState;
