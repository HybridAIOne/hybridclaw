import { describe, expect, test } from 'vitest';
import {
  ADMIN_RBAC_ACTIONS,
  ADMIN_RBAC_ROLE_ACTIONS,
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
});
