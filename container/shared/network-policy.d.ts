export type NetworkPolicyAction = 'allow' | 'deny';

export interface NetworkRule {
  action: NetworkPolicyAction;
  host: string;
  port: number | '*';
  methods: string[];
  paths: string[];
  agent: string;
  comment?: string;
}

export interface NetworkPolicyState {
  defaultAction: NetworkPolicyAction;
  rules: NetworkRule[];
  presets: string[];
}

export const DEFAULT_NETWORK_DEFAULT: NetworkPolicyAction;
export const DEFAULT_NETWORK_RULES: NetworkRule[];

export function asRecord(value: unknown): Record<string, unknown>;
export function normalizePresetNames(presets: unknown): string[];
export function normalizeNetworkHostScope(host: unknown): string;
export function doesNetworkHostPatternExpandToSubdomains(
  host: unknown,
): boolean;
export function normalizeNetworkPathPattern(rawPath: unknown): string;
export function normalizeNetworkAgent(raw: unknown): string;
export function normalizeNetworkPort(raw: unknown): number | '*' | null;
export function normalizeNetworkRule(raw: unknown): NetworkRule | null;
export function readNetworkPolicyState(
  document: Record<string, unknown>,
): NetworkPolicyState;
