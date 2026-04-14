export const DEFAULT_NETWORK_DEFAULT = 'deny';

export const DEFAULT_NETWORK_RULES = [
  {
    action: 'allow',
    host: 'hybridclaw.io',
    port: 443,
    methods: ['*'],
    paths: ['/**'],
    agent: '*',
  },
];

const IPV4_HOST_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const COMMON_SECOND_LEVEL_TLDS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'net',
  'org',
]);

export function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeNetworkAction(raw) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase();
  return normalized === 'deny' ? 'deny' : 'allow';
}

function normalizeCsvOrList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeNetworkMethods(raw) {
  const normalized = normalizeCsvOrList(raw).map((entry) =>
    entry.toUpperCase(),
  );
  if (normalized.length === 0) return ['*'];
  if (normalized.includes('*')) return ['*'];
  return [...new Set(normalized)];
}

export function normalizeNetworkPathPattern(rawPath) {
  const trimmed = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/');
  if (!trimmed) return '/**';
  if (trimmed.startsWith('/')) return trimmed;
  return `/${trimmed.replace(/^\/+/, '')}`;
}

function normalizeNetworkPaths(raw) {
  const normalized = normalizeCsvOrList(raw).map((entry) =>
    normalizeNetworkPathPattern(entry),
  );
  if (normalized.length === 0) return ['/**'];
  return [...new Set(normalized)];
}

export function normalizeNetworkAgent(raw) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase();
  return normalized || '*';
}

export function normalizeNetworkPort(raw) {
  const normalized = String(raw ?? '').trim();
  if (!normalized) return '*';
  if (normalized === '*') return '*';
  const parsed =
    typeof raw === 'number' ? raw : Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) return null;
  return Math.trunc(parsed);
}

export function normalizeNetworkHostScope(host) {
  const normalized = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!normalized) return 'unknown-host';
  if (IPV4_HOST_RE.test(normalized)) return normalized;
  if (normalized.includes(':')) return normalized;

  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 2) return normalized;

  const secondLevel = labels[labels.length - 2];
  const topLevel = labels[labels.length - 1];
  if (
    topLevel.length === 2 &&
    COMMON_SECOND_LEVEL_TLDS.has(secondLevel) &&
    labels.length >= 3
  ) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

export function doesNetworkHostPatternExpandToSubdomains(host) {
  const normalized = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!normalized || normalized.includes('*')) return false;
  if (IPV4_HOST_RE.test(normalized) || normalized.includes(':')) return false;
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length < 2) return false;
  return normalized === normalizeNetworkHostScope(normalized);
}

export function normalizeNetworkRule(raw) {
  const host = String(raw?.host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return null;
  const port = normalizeNetworkPort(raw?.port);
  if (port == null) return null;
  const comment = String(raw?.comment || '').trim();
  return {
    action: normalizeNetworkAction(raw?.action),
    host,
    port,
    methods: normalizeNetworkMethods(raw?.methods),
    paths: normalizeNetworkPaths(raw?.paths),
    agent: normalizeNetworkAgent(raw?.agent),
    ...(comment ? { comment } : {}),
  };
}

export function normalizePresetNames(presets) {
  if (!Array.isArray(presets)) return [];
  return [
    ...new Set(
      presets
        .map((preset) =>
          String(preset || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
}

export function readNetworkPolicyState(document) {
  const network = asRecord(document?.network);
  const approval = asRecord(document?.approval);
  const rulesDeclared = Array.isArray(network.rules);
  const networkRules = rulesDeclared
    ? network.rules
        .map((rule) => normalizeNetworkRule(asRecord(rule)))
        .filter(Boolean)
    : [];
  const legacyTrustedHosts =
    !rulesDeclared && Array.isArray(approval.trusted_network_hosts)
      ? approval.trusted_network_hosts
          .map((host) =>
            normalizeNetworkRule({
              action: 'allow',
              host: String(host || ''),
              methods: ['*'],
              paths: ['/**'],
              agent: '*',
            }),
          )
          .filter(Boolean)
      : [];

  return {
    defaultAction:
      String(network.default || '')
        .trim()
        .toLowerCase() === 'allow'
        ? 'allow'
        : DEFAULT_NETWORK_DEFAULT,
    rules:
      networkRules.length > 0 || rulesDeclared
        ? networkRules
        : legacyTrustedHosts.length > 0
          ? legacyTrustedHosts
          : DEFAULT_NETWORK_RULES.map((rule) => ({
              ...rule,
              methods: [...rule.methods],
              paths: [...rule.paths],
            })),
    presets: normalizePresetNames(network.presets),
  };
}
