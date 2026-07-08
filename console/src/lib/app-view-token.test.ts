import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppViewToken } from './app-view-token';

const { createAdminApiTokenMock } = vi.hoisted(() => ({
  createAdminApiTokenMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  createAdminApiToken: (...args: unknown[]) => createAdminApiTokenMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  createAdminApiTokenMock.mockReset();
});

describe('createAppViewToken', () => {
  it('mints a short-lived token scoped to one app view and bridge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T10:00:00.000Z'));
    createAdminApiTokenMock.mockResolvedValueOnce({ token: 'hck_app_token' });

    await expect(createAppViewToken('admin-token', 'app-123')).resolves.toBe(
      'hck_app_token',
    );

    expect(createAdminApiTokenMock).toHaveBeenCalledWith('admin-token', {
      label: 'App view app-123',
      claims: {
        actions: ['apps.view', 'apps.bridge'],
        appIds: ['app-123'],
      },
      expiresAt: '2026-07-08T10:30:00.000Z',
    });
  });
});
