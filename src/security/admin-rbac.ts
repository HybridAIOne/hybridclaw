export const ADMIN_SECRET_RBAC_ACTIONS = [
  'secret.list_metadata',
  'secret.overwrite',
  'secret.unset',
] as const;

export const ADMIN_RBAC_ACTIONS = [
  ...ADMIN_SECRET_RBAC_ACTIONS,
  'admin.overview.read',
  'admin.tunnel.reconnect',
  'admin.statistics.read',
  'admin.logs.read',
  'admin.team.read',
  'admin.team.write',
  'admin.agents.read',
  'admin.agents.write',
  'admin.agents.delete',
  'admin.hybridai.bots.read',
  'admin.agent_scoreboard.read',
  'admin.harness_evolution.read',
  'admin.models.read',
  'admin.models.write',
  'admin.sessions.read',
  'admin.sessions.delete',
  'admin.email.read',
  'admin.email.delete',
  'admin.scheduler.read',
  'admin.scheduler.write',
  'admin.scheduler.delete',
  'admin.channels.read',
  'admin.channels.write',
  'admin.channels.delete',
  'admin.mcp.read',
  'admin.mcp.write',
  'admin.mcp.delete',
  'admin.config.read',
  'admin.config.write',
  'admin.config.reload',
  'admin.browser_pool.read',
  'admin.browser_pool.start',
  'admin.webhook_targets.write',
  'admin.a2a.read',
  'admin.a2a.write',
  'admin.a2a.delete',
  'admin.fleet.read',
  'admin.fleet.write',
  'admin.fleet.delete',
  'admin.signal.read',
  'admin.signal.write',
  'admin.email_config.fetch',
  'admin.audit.read',
  'admin.approvals.read',
  'admin.policy.write',
  'admin.policy.delete',
  'admin.tools.read',
  'admin.plugins.read',
  'admin.output_guard.read',
  'admin.output_guard.write',
  'admin.output_guard.preview',
  'admin.distill.read',
  'admin.distill.write',
  'admin.distill.delete',
  'admin.skills.read',
  'admin.skills.write',
  'admin.skills.unblock',
  'admin.skills.upload',
  'admin.jobs.read',
  'admin.jobs.write',
  'admin.jobs.delete',
  'admin.terminal.start',
  'admin.terminal.stop',
  'admin.terminal.stream',
  'admin.gateway.shutdown',
  'admin.gateway.restart',
] as const;

export type AdminRbacAction = (typeof ADMIN_RBAC_ACTIONS)[number];

const ADMIN_READ_ACTIONS = [
  'admin.overview.read',
  'admin.statistics.read',
  'admin.logs.read',
  'admin.team.read',
  'admin.agents.read',
  'admin.hybridai.bots.read',
  'admin.agent_scoreboard.read',
  'admin.harness_evolution.read',
  'admin.models.read',
  'admin.sessions.read',
  'admin.email.read',
  'admin.scheduler.read',
  'admin.channels.read',
  'admin.mcp.read',
  'admin.config.read',
  'admin.browser_pool.read',
  'admin.a2a.read',
  'admin.fleet.read',
  'admin.signal.read',
  'admin.email_config.fetch',
  'admin.audit.read',
  'admin.approvals.read',
  'admin.tools.read',
  'admin.plugins.read',
  'admin.output_guard.read',
  'admin.distill.read',
  'admin.skills.read',
  'admin.jobs.read',
] as const satisfies readonly AdminRbacAction[];

export const ADMIN_RBAC_ROLE_ACTIONS = {
  'admin.viewer': ADMIN_READ_ACTIONS,
  'admin.operator': [
    ...ADMIN_READ_ACTIONS,
    'admin.tunnel.reconnect',
    'admin.sessions.delete',
    'admin.scheduler.write',
    'admin.scheduler.delete',
    'admin.browser_pool.start',
    'admin.distill.write',
    'admin.distill.delete',
    'admin.jobs.write',
    'admin.jobs.delete',
  ],
  'admin.integrations_manager': [
    ...ADMIN_READ_ACTIONS,
    'admin.team.write',
    'admin.agents.write',
    'admin.agents.delete',
    'admin.models.write',
    'admin.channels.write',
    'admin.channels.delete',
    'admin.mcp.write',
    'admin.mcp.delete',
    'admin.webhook_targets.write',
    'admin.a2a.write',
    'admin.a2a.delete',
    'admin.fleet.write',
    'admin.fleet.delete',
    'admin.signal.write',
  ],
  'admin.config_manager': [
    ...ADMIN_READ_ACTIONS,
    'admin.config.write',
    'admin.config.reload',
    'admin.models.write',
    'admin.channels.write',
    'admin.channels.delete',
    'admin.mcp.write',
    'admin.mcp.delete',
    'admin.webhook_targets.write',
    'admin.email_config.fetch',
  ],
  'admin.security_manager': [
    ...ADMIN_READ_ACTIONS,
    ...ADMIN_SECRET_RBAC_ACTIONS,
    'admin.policy.write',
    'admin.policy.delete',
    'admin.output_guard.write',
    'admin.output_guard.preview',
    'admin.skills.write',
    'admin.skills.unblock',
    'admin.skills.upload',
  ],
  'admin.terminal_operator': [
    'admin.overview.read',
    'admin.jobs.read',
    'admin.terminal.start',
    'admin.terminal.stop',
    'admin.terminal.stream',
  ],
  'admin.full': ADMIN_RBAC_ACTIONS,
} as const satisfies Record<string, readonly AdminRbacAction[]>;

export type AdminRbacRole = keyof typeof ADMIN_RBAC_ROLE_ACTIONS;

function readClaimValue(
  payload: Record<string, unknown>,
  key: 'actions' | 'scope' | 'role' | 'roles',
): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : undefined;
}

function addStringClaims(
  claims: Set<string>,
  value: unknown,
  splitPattern: RegExp,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        claims.add(entry.trim());
      }
    }
    return;
  }
  if (typeof value !== 'string') return;
  for (const entry of value.split(splitPattern)) {
    if (entry.trim()) claims.add(entry.trim());
  }
}

function isAdminRbacRole(value: string): value is AdminRbacRole {
  return Object.hasOwn(ADMIN_RBAC_ROLE_ACTIONS, value);
}

export function collectAdminRoleClaims(
  payload: Record<string, unknown> | null,
): Set<string> | null {
  if (!payload) return null;
  const roles = new Set<string>();
  addStringClaims(roles, readClaimValue(payload, 'role'), /[,\s]+/);
  addStringClaims(roles, readClaimValue(payload, 'roles'), /[,\s]+/);
  return roles;
}

export function collectAdminActionClaims(
  payload: Record<string, unknown> | null,
): Set<string> | null {
  if (!payload) return null;
  const claims = new Set<string>();

  addStringClaims(claims, readClaimValue(payload, 'actions'), /[,\s]+/);

  for (const role of collectAdminRoleClaims(payload) || []) {
    if (!isAdminRbacRole(role)) continue;
    for (const action of ADMIN_RBAC_ROLE_ACTIONS[role]) {
      claims.add(action);
    }
  }

  const scope = readClaimValue(payload, 'scope');
  if (typeof scope === 'string') {
    addStringClaims(claims, scope, /\s+/);
  }

  return claims;
}

function hasWildcardClaim(
  claims: Set<string>,
  action: AdminRbacAction,
): boolean {
  if (claims.has('*')) return true;
  const segments = action.split('.');
  while (segments.length > 0) {
    if (claims.has(`${segments.join('.')}:*`)) return true;
    segments.pop();
  }
  return false;
}

export function isAdminActionAllowed(
  payload: Record<string, unknown> | null,
  action: AdminRbacAction,
): boolean {
  if (!payload) return true;
  const claims = collectAdminActionClaims(payload);
  return (
    claims?.has(action) === true ||
    (claims ? hasWildcardClaim(claims, action) : false)
  );
}

function actionForReadWriteDelete(
  method: string,
  readAction: AdminRbacAction,
  writeAction: AdminRbacAction,
  deleteAction?: AdminRbacAction,
): AdminRbacAction | null {
  if (method === 'GET') return readAction;
  if (method === 'POST' || method === 'PUT') return writeAction;
  if (method === 'DELETE') return deleteAction || writeAction;
  return null;
}

function isPathOrChild(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function resolveAdminRbacAction(
  pathname: string,
  rawMethod: string,
): AdminRbacAction | null {
  const method = rawMethod.toUpperCase();
  if (pathname === '/api/admin/overview' && method === 'GET') {
    return 'admin.overview.read';
  }
  if (pathname === '/api/admin/secrets' && method === 'GET') {
    return 'secret.list_metadata';
  }
  if (pathname.startsWith('/api/admin/secrets/')) {
    if (method === 'PUT') return 'secret.overwrite';
    if (method === 'DELETE') return 'secret.unset';
    return null;
  }
  if (pathname === '/api/admin/tunnel/reconnect' && method === 'POST') {
    return 'admin.tunnel.reconnect';
  }
  if (pathname === '/api/admin/statistics' && method === 'GET') {
    return 'admin.statistics.read';
  }
  if (pathname === '/api/admin/logs' && method === 'GET') {
    return 'admin.logs.read';
  }
  if (isPathOrChild(pathname, '/api/admin/team-structure')) {
    if (method === 'GET') return 'admin.team.read';
    if (method === 'POST') return 'admin.team.write';
    return null;
  }
  if (isPathOrChild(pathname, '/api/admin/agents')) {
    if (method === 'GET') return 'admin.agents.read';
    if (method === 'POST' || method === 'PUT') return 'admin.agents.write';
    if (method === 'DELETE') return 'admin.agents.delete';
    return null;
  }
  if (pathname === '/api/admin/hybridai/bots' && method === 'GET') {
    return 'admin.hybridai.bots.read';
  }
  if (pathname === '/api/admin/agent-scoreboard' && method === 'GET') {
    return 'admin.agent_scoreboard.read';
  }
  if (pathname === '/api/admin/harness-evolution' && method === 'GET') {
    return 'admin.harness_evolution.read';
  }
  if (pathname === '/api/admin/models') {
    if (method === 'GET') return 'admin.models.read';
    if (method === 'PUT') return 'admin.models.write';
    return null;
  }
  if (pathname === '/api/admin/sessions') {
    if (method === 'GET') return 'admin.sessions.read';
    if (method === 'DELETE') return 'admin.sessions.delete';
    return null;
  }
  if (
    pathname === '/api/admin/email' ||
    pathname === '/api/admin/email/messages' ||
    pathname === '/api/admin/email/message'
  ) {
    if (method === 'GET') return 'admin.email.read';
    if (pathname === '/api/admin/email/message' && method === 'DELETE') {
      return 'admin.email.delete';
    }
    return null;
  }
  if (pathname === '/api/admin/scheduler') {
    if (method === 'GET') return 'admin.scheduler.read';
    if (method === 'POST' || method === 'PUT') return 'admin.scheduler.write';
    if (method === 'DELETE') return 'admin.scheduler.delete';
    return null;
  }
  if (pathname === '/api/admin/channels') {
    return actionForReadWriteDelete(
      method,
      'admin.channels.read',
      'admin.channels.write',
      'admin.channels.delete',
    );
  }
  if (pathname === '/api/admin/mcp') {
    return actionForReadWriteDelete(
      method,
      'admin.mcp.read',
      'admin.mcp.write',
      'admin.mcp.delete',
    );
  }
  if (pathname === '/api/admin/config') {
    if (method === 'GET') return 'admin.config.read';
    if (method === 'PUT') return 'admin.config.write';
    return null;
  }
  if (pathname === '/api/admin/config/reload' && method === 'POST') {
    return 'admin.config.reload';
  }
  if (pathname === '/api/admin/browser-pool/health' && method === 'GET') {
    return 'admin.browser_pool.read';
  }
  if (pathname === '/api/admin/browser-pool/start' && method === 'POST') {
    return 'admin.browser_pool.start';
  }
  if (
    (pathname === '/api/admin/slack-webhook-targets' ||
      pathname === '/api/admin/discord-webhook-targets') &&
    (method === 'POST' || method === 'PUT')
  ) {
    return 'admin.webhook_targets.write';
  }
  if (pathname === '/api/admin/a2a/inbox' && method === 'GET') {
    return 'admin.a2a.read';
  }
  if (pathname === '/api/admin/a2a/trust') {
    return actionForReadWriteDelete(
      method,
      'admin.a2a.read',
      'admin.a2a.write',
      'admin.a2a.delete',
    );
  }
  if (pathname === '/api/admin/a2a/pairing/preview' && method === 'POST') {
    return 'admin.a2a.read';
  }
  if (
    (pathname === '/api/admin/a2a/pairing' ||
      pathname === '/api/admin/a2a/pairing/approve' ||
      pathname === '/api/admin/a2a/pairing/decline') &&
    method === 'POST'
  ) {
    return 'admin.a2a.write';
  }
  if (pathname === '/api/admin/fleet-topology') {
    return actionForReadWriteDelete(
      method,
      'admin.fleet.read',
      'admin.fleet.write',
      'admin.fleet.delete',
    );
  }
  if (pathname === '/api/admin/signal/link') {
    if (method === 'GET') return 'admin.signal.read';
    if (method === 'POST') return 'admin.signal.write';
    return null;
  }
  if (pathname === '/api/admin/email-config/fetch' && method === 'GET') {
    return 'admin.email_config.fetch';
  }
  if (pathname === '/api/admin/audit' && method === 'GET') {
    return 'admin.audit.read';
  }
  if (pathname === '/api/admin/approvals' && method === 'GET') {
    return 'admin.approvals.read';
  }
  if (pathname === '/api/admin/policy') {
    if (method === 'PUT') return 'admin.policy.write';
    if (method === 'DELETE') return 'admin.policy.delete';
    return null;
  }
  if (pathname === '/api/admin/tools' && method === 'GET') {
    return 'admin.tools.read';
  }
  if (pathname === '/api/admin/plugins' && method === 'GET') {
    return 'admin.plugins.read';
  }
  if (pathname === '/api/admin/output-guard') {
    if (method === 'GET') return 'admin.output_guard.read';
    if (method === 'PUT') return 'admin.output_guard.write';
    return null;
  }
  if (pathname === '/api/admin/output-guard/preview' && method === 'POST') {
    return 'admin.output_guard.preview';
  }
  if (isPathOrChild(pathname, '/api/admin/distill')) {
    if (method === 'GET') return 'admin.distill.read';
    if (method === 'POST') return 'admin.distill.write';
    if (method === 'DELETE') return 'admin.distill.delete';
    return null;
  }
  if (pathname === '/api/admin/skills') {
    if (method === 'GET') return 'admin.skills.read';
    if (method === 'POST' || method === 'PUT') return 'admin.skills.write';
    return null;
  }
  if (pathname === '/api/admin/skills/unblock' && method === 'POST') {
    return 'admin.skills.unblock';
  }
  if (pathname === '/api/admin/skills/upload' && method === 'POST') {
    return 'admin.skills.upload';
  }
  if (
    pathname === '/api/admin/jobs/context' ||
    pathname === '/api/admin/jobs/budgets' ||
    pathname === '/api/admin/jobs/blocked'
  ) {
    return method === 'GET' ? 'admin.jobs.read' : null;
  }
  if (pathname === '/api/admin/jobs/edges') {
    if (method === 'GET') return 'admin.jobs.read';
    if (method === 'POST') return 'admin.jobs.write';
    if (method === 'DELETE') return 'admin.jobs.delete';
    return null;
  }
  if (pathname === '/api/admin/jobs/edge-revisions') {
    if (method === 'GET') return 'admin.jobs.read';
    if (method === 'POST') return 'admin.jobs.write';
    return null;
  }
  if (pathname === '/api/admin/terminal') {
    if (method === 'POST') return 'admin.terminal.start';
    if (method === 'DELETE') return 'admin.terminal.stop';
    return null;
  }
  if (pathname === '/api/admin/terminal/stream' && method === 'GET') {
    return 'admin.terminal.stream';
  }
  if (pathname === '/api/admin/shutdown' && method === 'POST') {
    return 'admin.gateway.shutdown';
  }
  if (pathname === '/api/admin/restart' && method === 'POST') {
    return 'admin.gateway.restart';
  }
  return null;
}
