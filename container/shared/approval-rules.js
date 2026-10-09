/**
 * Approval rules — what a durable "always allow" covers, in words a person
 * can check, and the stores that keep those grants.
 *
 * A grant trusts one action key (`bash:delete`, `network:api.example.com`,
 * `message:send:pat@example.com`) for the agent (`yes for agent`) or for every
 * agent of the workspace (`yes for all`). `describeApprovalAction` names the
 * kind of action a key covers; clients localize `category` and show `target`.
 * NOT the approval pipeline (`container/src/approval-policy.ts`) and NOT the
 * network rules of `policy.yaml` (`/policy`).
 */

/** Why the pipeline paused a call, from the rule that raised it. */
export const APPROVAL_PAUSE_CAUSES = [
  'risky',
  'ask_mode',
  'protected',
  'unusual',
  'workspace_policy',
];

/** Store files, relative to the agent workspace. */
export const APPROVAL_TRUST_STORE_FILES = {
  agent: '.hybridclaw/approval-agent-trust.json',
  all: 'approval-trust.json',
};

export const LEGACY_AGENT_TRUST_STORE_FILE = '.hybridclaw/approval-trust.json';

function cleanList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : null;
}

function cleanText(value, limit) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, limit) : undefined;
}

function webTarget(rest) {
  // `<host>[:<METHOD>[:<path>]]`; a port belongs to the host.
  const parts = rest.split(':');
  const host = parts.shift() || '';
  if (parts[0] && /^\d+$/.test(parts[0])) {
    return { host: `${host}:${parts.shift()}`, method: parts[0] };
  }
  return { host, method: parts[0] };
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const COMMAND_CATEGORIES = {
  delete: 'delete_files',
  'delete-cache': 'delete_files',
  'write-op': 'change_files',
  'install-deps': 'install_packages',
  'fetched-code': 'run_downloaded_code',
  'host-control': 'control_computer',
  'workspace-fence': 'outside_workspace',
};

const LABELS = {
  delete_files: 'Delete files',
  change_files: 'Change files',
  memory: 'Update memory',
  run_commands: 'Run commands',
  install_packages: 'Install packages',
  run_downloaded_code: 'Run downloaded code',
  control_computer: 'Control the computer',
  outside_workspace: 'Work outside the workspace',
  web_requests: 'Use websites',
  send_to_websites: 'Send data to websites',
  web_search: 'Search the web',
  send_messages: 'Send messages',
  browser: 'Use the browser',
  purchase: 'Place orders',
  cancel_subscription: 'Cancel subscriptions',
  connector: 'Use a connected app',
  tool: 'Use a tool',
};

function described(category, target) {
  const label = LABELS[category];
  return target
    ? { category, target, label: `${label}: ${target}` }
    : { category, label };
}

/**
 * The kind of action an action key covers. `target` narrows it: a folder, a
 * host, a recipient, a tool. Unknown keys read as a tool named by the key.
 */
export function describeApprovalAction(actionKey) {
  const key = String(actionKey || '').trim();
  const [head, ...restParts] = key.split(':');
  const rest = restParts.join(':');
  switch (head) {
    case 'bash': {
      if (rest.startsWith('network:')) {
        return described('web_requests', rest.slice('network:'.length));
      }
      return described(COMMAND_CATEGORIES[rest] || 'run_commands');
    }
    case 'delete':
    case 'write':
    case 'edit': {
      const folder = rest && rest !== 'root' && rest !== 'unknown' ? rest : '';
      return described(
        head === 'delete' ? 'delete_files' : 'change_files',
        folder || undefined,
      );
    }
    case 'memory':
      return described('memory');
    case 'network': {
      if (rest === 'web-search') return described('web_search');
      if (!rest || rest === 'unknown-host') return described('web_requests');
      const { host, method } = webTarget(rest);
      const sends = method && !READ_METHODS.has(method.toUpperCase());
      return described(sends ? 'send_to_websites' : 'web_requests', host);
    }
    case 'message': {
      const target = restParts[1];
      return described(
        'send_messages',
        target && target !== 'current' ? target : undefined,
      );
    }
    case 'browser_stealth':
      return described(
        'browser',
        rest && rest !== 'unknown-host' ? rest : undefined,
      );
    case 'browser_purchase':
      return described(
        'purchase',
        rest && rest !== 'unknown' ? rest : undefined,
      );
    case 'browser_cancellation':
      return described(
        'cancel_subscription',
        rest && rest !== 'unknown' ? rest : undefined,
      );
    case 'mcp': {
      // `mcp:<server>:<kind>[:<tool>]`
      const [server, , tool] = restParts;
      return described('connector', tool || server || undefined);
    }
    default:
      return described('tool', key || undefined);
  }
}

/**
 * A store file's contents, or null when it is not a store. Grants describe the
 * keys granted since grants were kept; older keys have none.
 */
export function parseApprovalTrustStore(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const actions =
    cleanList(parsed.allowlistedActions) || cleanList(parsed.trustedActions);
  const fingerprints =
    cleanList(parsed.allowlistedFingerprints) ||
    cleanList(parsed.trustedFingerprints);
  const grants = [];
  for (const item of Array.isArray(parsed.grants) ? parsed.grants : []) {
    if (!item || typeof item !== 'object') continue;
    const actionKey = cleanText(item.actionKey, 500);
    if (!actionKey) continue;
    const grant = {
      actionKey,
      fingerprints: cleanList(item.fingerprints) || [],
    };
    const intent = cleanText(item.intent, 300);
    const toolName = cleanText(item.toolName, 120);
    const grantedAt = cleanText(item.grantedAt, 40);
    if (intent) grant.intent = intent;
    if (toolName) grant.toolName = toolName;
    if (grantedAt) grant.grantedAt = grantedAt;
    grants.push(grant);
  }
  return {
    actions: actions || [],
    fingerprints: fingerprints || [],
    grants,
  };
}

export function serializeApprovalTrustStore(store, now = new Date()) {
  const actions = [...new Set(store.actions)].sort();
  const granted = new Set(actions);
  return JSON.stringify(
    {
      version: 2,
      allowlistedActions: actions,
      allowlistedFingerprints: [...new Set(store.fingerprints)].sort(),
      grants: store.grants
        .filter((grant) => granted.has(grant.actionKey))
        .sort((a, b) => a.actionKey.localeCompare(b.actionKey)),
      updatedAt: now.toISOString(),
    },
    null,
    2,
  );
}

/**
 * Adds or refreshes the grant for one call's action key. The fingerprint is
 * kept with the grant, so revoking the key revokes the exact call too.
 */
export function grantApprovalTrust(store, input, now = new Date()) {
  const actionKey = String(input.actionKey || '').trim();
  const fingerprint = String(input.fingerprint || '').trim();
  const actions = new Set(store.actions);
  const fingerprints = new Set(store.fingerprints);
  if (actionKey) actions.add(actionKey);
  if (fingerprint) fingerprints.add(fingerprint);
  const existing = store.grants.find((grant) => grant.actionKey === actionKey);
  const grant = {
    actionKey,
    fingerprints: [
      ...new Set([...(existing?.fingerprints || []), fingerprint]),
    ].filter(Boolean),
  };
  const intent = cleanText(input.intent, 300) || existing?.intent;
  const toolName = cleanText(input.toolName, 120) || existing?.toolName;
  if (intent) grant.intent = intent;
  if (toolName) grant.toolName = toolName;
  grant.grantedAt = existing?.grantedAt || now.toISOString();
  return {
    actions: [...actions],
    fingerprints: [...fingerprints],
    grants: [
      ...store.grants.filter((item) => item.actionKey !== actionKey),
      ...(actionKey ? [grant] : []),
    ],
  };
}

/**
 * Removes one action key with the fingerprints granted alongside it. Exact
 * calls granted before grants were kept belong to no key, so any revoke drops
 * them too: that can only make a call ask again, never skip asking.
 */
export function revokeApprovalTrust(store, actionKey) {
  const key = String(actionKey || '').trim();
  if (!store.actions.includes(key)) return { store, revoked: false };
  const grants = store.grants.filter((grant) => grant.actionKey !== key);
  const kept = new Set(grants.flatMap((grant) => grant.fingerprints));
  return {
    store: {
      actions: store.actions.filter((item) => item !== key),
      fingerprints: store.fingerprints.filter((item) => kept.has(item)),
      grants,
    },
    revoked: true,
  };
}

/** The rule an approval card shows: what paused the call and what it covers. */
export function approvalRuleFor(actionKey, pausedBy) {
  return {
    actionKey: String(actionKey || '').trim(),
    ...describeApprovalAction(actionKey),
    pausedBy,
  };
}

/** A rule read back from IPC; null unless every field is one it can be. */
export function parseApprovalRule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actionKey = cleanText(value.actionKey, 500);
  if (!actionKey || !APPROVAL_PAUSE_CAUSES.includes(value.pausedBy)) {
    return null;
  }
  return approvalRuleFor(actionKey, value.pausedBy);
}
