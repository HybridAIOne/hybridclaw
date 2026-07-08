import { describe, expect, test } from 'vitest';
import {
  ADMIN_RBAC_ACTIONS,
  ADMIN_RBAC_ROLE_ACTIONS,
  ADMIN_RBAC_ROLE_BUNDLES,
  collectAdminActionClaims,
  collectAdminRoleClaims,
  isAdminActionAllowed,
  resolveAdminRbacAction,
} from '../src/security/admin-rbac.js';

describe('admin RBAC role bundles', () => {
  test('keeps every role action inside the admin action catalog', () => {
    const actionCatalog = new Set<string>(ADMIN_RBAC_ACTIONS);

    for (const actions of Object.values(ADMIN_RBAC_ROLE_ACTIONS)) {
      for (const action of actions) {
        expect(actionCatalog.has(action)).toBe(true);
      }
    }
  });

  test('keeps legacy bearer-token requests fully authorized without session claims', () => {
    expect(isAdminActionAllowed(null, 'admin.config.write')).toBe(true);
  });

  test('keeps unscoped HybridAI session claims fully authorized', () => {
    const payload = {
      sub: 'user-1',
      sessionId: 'admin-session-1',
    };

    expect(collectAdminActionClaims(payload)).toBeNull();
    expect(isAdminActionAllowed(payload, 'admin.skills.read')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.gateway.shutdown')).toBe(true);
  });

  test('expands config manager role claims into route actions', () => {
    const payload = { role: 'admin.config_manager' };
    const claims = collectAdminActionClaims(payload);

    expect(claims?.has('admin.tunnel.write')).toBe(true);
    expect(claims?.has('admin.config.reload')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.config.reload')).toBe(true);
    expect(isAdminActionAllowed(payload, 'secret.overwrite')).toBe(false);
  });

  test('grants API token management only to security and full roles', () => {
    expect(
      isAdminActionAllowed({ role: 'admin.security_manager' }, 'admin.tokens.create'),
    ).toBe(true);
    expect(
      isAdminActionAllowed({ role: 'admin.viewer' }, 'admin.tokens.read'),
    ).toBe(false);
    expect(isAdminActionAllowed({ role: 'admin.full' }, 'openai.api')).toBe(
      true,
    );
  });

  test('combines roles arrays with explicit action claims', () => {
    const payload = {
      roles: ['admin.security_manager', 'admin.terminal_operator'],
      actions: ['admin.gateway.restart'],
    };

    expect(isAdminActionAllowed(payload, 'secret.list_metadata')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.terminal.stream')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.gateway.restart')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.gateway.shutdown')).toBe(false);
  });

  test('ignores unknown role names instead of broadening access', () => {
    const payload = { roles: 'admin.viewer admin.unknown' };

    expect(collectAdminRoleClaims(payload)).toEqual(
      new Set(['admin.viewer', 'admin.unknown']),
    );
    expect(isAdminActionAllowed(payload, 'admin.overview.read')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.config.reload')).toBe(false);
  });

  test('expands auditor role claims into read-only actions', () => {
    const payload = { roles: ['admin:auditor'] };

    expect(collectAdminRoleClaims(payload)).toEqual(
      new Set(['admin:auditor']),
    );
    expect(isAdminActionAllowed(payload, 'admin.audit.read')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.config.write')).toBe(false);
  });

  test('expands owner role claims into the full action catalog', () => {
    const payload = { role: 'admin:owner' };

    expect(isAdminActionAllowed(payload, 'secret.overwrite')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.gateway.restart')).toBe(true);
  });

  test('combines explicit actions, scope strings, and role bundles', () => {
    const claims = collectAdminActionClaims({
      actions: 'admin.overview.read',
      scope: 'admin.config:*',
      roles: 'admin:secret-manager',
    });

    expect(claims?.has('admin.overview.read')).toBe(true);
    expect(claims?.has('admin.config:*')).toBe(true);
    expect(claims?.has('secret.unset')).toBe(true);
    expect(
      isAdminActionAllowed({ roles: 'admin:secret-manager' }, 'secret.overwrite'),
    ).toBe(true);
    expect(
      isAdminActionAllowed(
        { roles: 'admin:secret-manager' },
        'admin.config.write',
      ),
    ).toBe(false);
  });

  test('publishes stable ISO role bundle names for access reviews', () => {
    expect(Object.keys(ADMIN_RBAC_ROLE_BUNDLES).sort()).toEqual([
      'admin:auditor',
      'admin:operator',
      'admin:owner',
      'admin:secret-manager',
    ]);
  });

  test('maps admin tunnel routes to scoped tunnel actions', () => {
    expect(resolveAdminRbacAction('/api/admin/tunnel', 'GET')).toBe(
      'admin.tunnel.read',
    );
    expect(resolveAdminRbacAction('/api/admin/tunnel', 'PUT')).toBe(
      'admin.tunnel.write',
    );
    expect(resolveAdminRbacAction('/api/admin/tunnel/reconnect', 'POST')).toBe(
      'admin.tunnel.reconnect',
    );
    expect(resolveAdminRbacAction('/api/admin/tunnel/stop', 'POST')).toBe(
      'admin.tunnel.stop',
    );
  });

  test('maps connector routes to read and secret mutation actions', () => {
    expect(resolveAdminRbacAction('/api/admin/connectors', 'GET')).toBe(
      'admin.connectors.read',
    );
    expect(
      resolveAdminRbacAction('/api/admin/connectors/hybridai/key', 'PUT'),
    ).toBe('secret.overwrite');
    expect(
      resolveAdminRbacAction('/api/admin/connectors/oauth/start', 'POST'),
    ).toBe('secret.overwrite');
    expect(resolveAdminRbacAction('/api/admin/connectors/test', 'POST')).toBe(
      'admin.connectors.read',
    );
    expect(
      resolveAdminRbacAction('/api/admin/connectors/logout', 'POST'),
    ).toBe('secret.unset');
  });

  test('maps API token and scoped API routes', () => {
    expect(resolveAdminRbacAction('/api/admin/tokens', 'GET')).toBe(
      'admin.tokens.read',
    );
    expect(resolveAdminRbacAction('/api/admin/tokens', 'POST')).toBe(
      'admin.tokens.create',
    );
    expect(resolveAdminRbacAction('/api/admin/tokens/abc123abc123', 'DELETE')).toBe(
      'admin.tokens.revoke',
    );
    expect(resolveAdminRbacAction('/v1/models', 'GET')).toBe('openai.api');
    expect(resolveAdminRbacAction('/api/chat', 'POST')).toBe('chat.send');
    expect(resolveAdminRbacAction('/api/command', 'POST')).toBe('chat.send');
    expect(resolveAdminRbacAction('/api/status', 'GET')).toBe('status.read');
    expect(resolveAdminRbacAction('/api/agents', 'GET')).toBe('agents.read');
    expect(resolveAdminRbacAction('/api/apps', 'GET')).toBe('apps.read');
    expect(resolveAdminRbacAction('/api/apps/app-1', 'GET')).toBe('apps.read');
    expect(resolveAdminRbacAction('/api/apps/app-1', 'PATCH')).toBe(
      'apps.write',
    );
    expect(
      resolveAdminRbacAction('/api/apps/app-1/publications', 'POST'),
    ).toBe('apps.write');
    expect(
      resolveAdminRbacAction('/api/apps/app-1/publications/pub-1', 'DELETE'),
    ).toBe('apps.write');
    expect(resolveAdminRbacAction('/api/apps/app-1/view', 'GET')).toBe(
      'apps.view',
    );
    expect(resolveAdminRbacAction('/api/apps/app-1/bridge/tool', 'POST')).toBe(
      'apps.bridge',
    );
    expect(resolveAdminRbacAction('/api/apps/app-1/teams-manifest', 'GET')).toBe(
      'apps.read',
    );
    expect(resolveAdminRbacAction('/api/admin/msteams/tab-status', 'GET')).toBe(
      'admin.config.read',
    );
    expect(
      resolveAdminRbacAction('/api/admin/msteams/tab-manifest', 'GET'),
    ).toBe('admin.config.read');
    expect(resolveAdminRbacAction('/api/apps/app-1', 'DELETE')).toBe(
      'apps.delete',
    );
  });
});
