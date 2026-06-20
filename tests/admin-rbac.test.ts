import { describe, expect, test } from 'vitest';
import {
  ADMIN_RBAC_ACTIONS,
  ADMIN_RBAC_ROLE_ACTIONS,
  ADMIN_RBAC_ROLE_BUNDLES,
  collectAdminActionClaims,
  collectAdminRoleClaims,
  isAdminActionAllowed,
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

    expect(claims?.has('admin.config.reload')).toBe(true);
    expect(isAdminActionAllowed(payload, 'admin.config.reload')).toBe(true);
    expect(isAdminActionAllowed(payload, 'secret.overwrite')).toBe(false);
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
});
