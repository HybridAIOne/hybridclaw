import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DATA_DIR } from '../config/config.js';
import { resolveInstallPath } from '../infra/install-root.js';

export interface ManagedBrowserTenantPolicy {
  ok: boolean;
  status: 'available' | 'unavailable';
  tenantId: string;
  policyPath: string;
  allowedHosts: string[];
  message: string;
}

type TenantPolicyDocument = {
  tenants?: Record<string, TenantPolicyEntry>;
};

type TenantPolicyEntry = {
  network?: {
    default?: string;
    rules?: TenantPolicyRule[];
  };
};

type TenantPolicyRule = {
  action?: string;
  host?: string;
  port?: number | string;
  methods?: string[];
  paths?: string[];
  agent?: string;
  [key: string]: unknown;
};

export function resolveLocalManagedBrowserTenantPolicyPath(
  dataDir = DATA_DIR,
): string {
  return path.join(dataDir, 'managed-browser', 'tenants.yaml');
}

function resolveExampleTenantPolicyPath(installRoot = resolveInstallPath()) {
  return path.join(
    installRoot,
    'infra',
    'managed-browser',
    'tenants.example.yaml',
  );
}

export function ensureLocalManagedBrowserTenantPolicyFile(
  params: { dataDir?: string; installRoot?: string } = {},
): string {
  const policyPath = resolveLocalManagedBrowserTenantPolicyPath(params.dataDir);
  if (fs.existsSync(policyPath)) return policyPath;
  fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 });
  const examplePath = resolveExampleTenantPolicyPath(params.installRoot);
  const initialContent = fs.existsSync(examplePath)
    ? fs.readFileSync(examplePath, 'utf-8')
    : YAML.stringify({ tenants: {} });
  fs.writeFileSync(policyPath, initialContent, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return policyPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readPolicyDocument(policyPath: string): TenantPolicyDocument {
  if (!fs.existsSync(policyPath)) {
    throw new Error(
      `Managed browser tenant policy file is missing: ${policyPath}`,
    );
  }
  const parsed = YAML.parse(fs.readFileSync(policyPath, 'utf-8'));
  if (!isRecord(parsed)) return { tenants: {} };
  const tenants = isRecord(parsed.tenants) ? parsed.tenants : {};
  return {
    ...parsed,
    tenants: Object.fromEntries(
      Object.entries(tenants).map(([tenantId, tenant]) => [
        tenantId,
        isRecord(tenant) ? (tenant as TenantPolicyEntry) : {},
      ]),
    ),
  };
}

function isBroadHttpsAllowRule(rule: TenantPolicyRule): boolean {
  const action = String(rule.action || '').toLowerCase();
  const port = String(rule.port ?? '');
  const methods = Array.isArray(rule.methods) ? rule.methods : [];
  const paths = Array.isArray(rule.paths) ? rule.paths : [];
  const agent = String(rule.agent || '*');
  return (
    action === 'allow' &&
    port === '443' &&
    (methods.length === 0 || methods.includes('*')) &&
    (paths.length === 0 || paths.includes('/**')) &&
    agent === '*'
  );
}

function normalizeAllowedHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let host = trimmed;
  if (/^https?:\/\//iu.test(trimmed)) {
    const parsed = new URL(trimmed);
    host = parsed.hostname;
  } else {
    host = trimmed.split('/')[0] || '';
    if (host.includes(':') && !host.startsWith('[')) {
      host = host.split(':')[0] || '';
    }
    if (host.startsWith('[') && host.includes(']')) {
      host = host.slice(1, host.indexOf(']'));
    }
  }
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (
    !normalized ||
    normalized.includes('@') ||
    normalized.includes(' ') ||
    normalized.includes('\\')
  ) {
    throw new Error(`Invalid managed browser allowed host: ${value}`);
  }
  return normalized;
}

export function normalizeManagedBrowserAllowedHosts(
  hosts: readonly string[],
): string[] {
  return [
    ...new Set(
      hosts
        .flatMap((host) => String(host || '').split(/[\n,]/u))
        .map((host) => normalizeAllowedHost(host))
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function readLocalManagedBrowserTenantPolicy(params: {
  tenantId: string;
  dataDir?: string;
  installRoot?: string;
}): ManagedBrowserTenantPolicy {
  const tenantId = params.tenantId.trim();
  const policyPath = ensureLocalManagedBrowserTenantPolicyFile(params);
  if (!tenantId) {
    return {
      ok: false,
      status: 'unavailable',
      tenantId,
      policyPath,
      allowedHosts: [],
      message: 'Set browser.managedCloud.defaultTenantId to edit host policy.',
    };
  }
  const document = readPolicyDocument(policyPath);
  const tenant = document.tenants?.[tenantId];
  const rules = Array.isArray(tenant?.network?.rules)
    ? tenant.network.rules
    : [];
  return {
    ok: true,
    status: 'available',
    tenantId,
    policyPath,
    allowedHosts: normalizeManagedBrowserAllowedHosts(
      rules
        .filter(isBroadHttpsAllowRule)
        .map((rule) => String(rule.host || '')),
    ),
    message:
      'Editing broad HTTPS allow rules for this managed browser tenant policy.',
  };
}

export function updateLocalManagedBrowserTenantAllowedHosts(params: {
  tenantId: string;
  allowedHosts: readonly string[];
  dataDir?: string;
  installRoot?: string;
}): ManagedBrowserTenantPolicy {
  const tenantId = params.tenantId.trim();
  const policyPath = ensureLocalManagedBrowserTenantPolicyFile(params);
  if (!tenantId) {
    throw new Error(
      'Set browser.managedCloud.defaultTenantId before editing host policy.',
    );
  }
  const allowedHosts = normalizeManagedBrowserAllowedHosts(params.allowedHosts);
  const document = readPolicyDocument(policyPath);
  document.tenants ??= {};
  const tenant = document.tenants[tenantId] ?? {};
  tenant.network ??= {};
  tenant.network.default ??= 'deny';
  const currentRules = Array.isArray(tenant.network.rules)
    ? tenant.network.rules
    : [];
  tenant.network.rules = [
    ...currentRules.filter((rule) => !isBroadHttpsAllowRule(rule)),
    ...allowedHosts.map((host) => ({
      action: 'allow',
      host,
      port: 443,
      methods: ['*'],
      paths: ['/**'],
      agent: '*',
    })),
  ];
  document.tenants[tenantId] = tenant;
  fs.writeFileSync(policyPath, YAML.stringify(document), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return readLocalManagedBrowserTenantPolicy({
    tenantId,
    dataDir: params.dataDir,
    installRoot: params.installRoot,
  });
}
