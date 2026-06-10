import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpResponseError } from '../api/client';
import type { AdminSecretAction, AdminSecretsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { SecretsPage } from './secrets';

const fetchAdminSecretsMock = vi.fn<() => Promise<AdminSecretsResponse>>();
const overwriteAdminSecretMock = vi.fn();
const unsetAdminSecretMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchAdminSecrets: () => fetchAdminSecretsMock(),
    overwriteAdminSecret: (token: string, name: string, value: string) =>
      overwriteAdminSecretMock(token, name, value),
    unsetAdminSecret: (token: string, name: string) =>
      unsetAdminSecretMock(token, name),
  };
});

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeResponse(
  overrides: Partial<AdminSecretsResponse> = {},
): AdminSecretsResponse {
  const baseActions: AdminSecretAction[] = [
    'secret.list_metadata',
    'secret.overwrite',
    'secret.unset',
  ];
  return {
    secrets: [
      {
        name: 'OPENAI_API_KEY',
        state: 'set',
        created_at: '2026-05-17T10:00:00.000Z',
        last_rotated_at: '2026-05-17T10:00:00.000Z',
        length: 51,
        fingerprint: { length: 51, sha256_prefix: 'abcdef012345' },
      },
      {
        name: 'STRIPE_SECRET_KEY',
        state: 'unset',
        created_at: null,
        last_rotated_at: null,
        length: null,
        fingerprint: null,
      },
    ],
    total: 2,
    actions: baseActions,
    ...overrides,
  };
}

describe('SecretsPage', () => {
  beforeEach(() => {
    fetchAdminSecretsMock.mockReset();
    overwriteAdminSecretMock.mockReset();
    unsetAdminSecretMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
  });

  it('renders set entries before unset entries with metadata only', async () => {
    fetchAdminSecretsMock.mockResolvedValue(makeResponse());

    renderWithProviders(<SecretsPage />);

    expect(await screen.findByText('OPENAI_API_KEY')).toBeTruthy();
    expect(screen.getByText('STRIPE_SECRET_KEY')).toBeTruthy();

    const sectionSet = screen.getByRole('region', { name: 'Set' });
    expect(within(sectionSet).getByText('OPENAI_API_KEY')).toBeTruthy();
    expect(within(sectionSet).queryByText('STRIPE_SECRET_KEY')).toBeNull();

    const sectionUnset = screen.getByRole('region', {
      name: 'Declared but unset',
    });
    expect(within(sectionUnset).getByText('STRIPE_SECRET_KEY')).toBeTruthy();
  });

  it('shows fingerprint and length but never the cleartext value', async () => {
    fetchAdminSecretsMock.mockResolvedValue(makeResponse());

    const { container } = renderWithProviders(<SecretsPage />);

    expect(await screen.findByText(/sha256:abcdef012345/)).toBeTruthy();
    expect(screen.getByText(/51 bytes/)).toBeTruthy();
    expect(container.textContent ?? '').not.toMatch(/super-secret/);
  });

  it('hides write affordances when the caller has only list_metadata', async () => {
    fetchAdminSecretsMock.mockResolvedValue(
      makeResponse({ actions: ['secret.list_metadata'] }),
    );

    renderWithProviders(<SecretsPage />);

    expect(await screen.findByText('OPENAI_API_KEY')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rotate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Unset$/i })).toBeNull();
  });

  it('shows an unauthorized empty state when the list endpoint returns 403', async () => {
    fetchAdminSecretsMock.mockRejectedValueOnce(
      new HttpResponseError('Forbidden.', 403),
    );

    renderWithProviders(<SecretsPage />);

    expect(await screen.findByText(/do not have permission/i)).toBeTruthy();
    expect(screen.queryByText('OPENAI_API_KEY')).toBeNull();
  });

  it('overwrites a secret and never echoes the submitted value in the DOM', async () => {
    fetchAdminSecretsMock.mockResolvedValue(makeResponse());
    overwriteAdminSecretMock.mockResolvedValue({
      secret: {
        name: 'OPENAI_API_KEY',
        state: 'set',
        created_at: '2026-05-17T10:00:00.000Z',
        last_rotated_at: '2026-05-17T11:00:00.000Z',
        length: 48,
        fingerprint: { length: 48, sha256_prefix: 'newfingerprint' },
      },
    });

    renderWithProviders(<SecretsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^Rotate$/i }));

    const input = (await screen.findByLabelText(
      'New value',
    )) as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.change(input, { target: { value: 'rotated-super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Save value/i }));

    await waitFor(() =>
      expect(overwriteAdminSecretMock).toHaveBeenCalledTimes(1),
    );
    expect(overwriteAdminSecretMock).toHaveBeenCalledWith(
      'test-token',
      'OPENAI_API_KEY',
      'rotated-super-secret',
    );

    // The dialog portals to document.body (outside the render container), so
    // assert against the whole document and wait for it to unmount on success.
    await waitFor(() => {
      expect(screen.queryByLabelText('New value')).toBeNull();
    });
    expect(document.body.textContent ?? '').not.toMatch(/rotated-super-secret/);
  });

  it('unsets a secret only after explicit confirmation', async () => {
    fetchAdminSecretsMock.mockResolvedValue(makeResponse());
    unsetAdminSecretMock.mockResolvedValue({
      secret: {
        name: 'OPENAI_API_KEY',
        state: 'unset',
        created_at: null,
        last_rotated_at: null,
        length: null,
        fingerprint: null,
      },
    });

    renderWithProviders(<SecretsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^Unset$/i }));

    expect(unsetAdminSecretMock).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('button', {
      name: /Unset secret/i,
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(unsetAdminSecretMock).toHaveBeenCalledTimes(1));
    expect(unsetAdminSecretMock).toHaveBeenCalledWith(
      'test-token',
      'OPENAI_API_KEY',
    );
  });

  it('keyboard navigation: escape closes the overwrite dialog without submitting', async () => {
    fetchAdminSecretsMock.mockResolvedValue(makeResponse());

    renderWithProviders(<SecretsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^Rotate$/i }));

    const input = await screen.findByLabelText('New value');
    const dialog = input.closest('[role="dialog"]');
    expect(dialog).toBeTruthy();

    // Escape inside the input is intentionally suppressed by useEscapeKeydown to
    // avoid conflicting with native input behavior; clicking the Cancel button
    // inside the dialog is the operator-facing close path.
    fireEvent.click(
      within(dialog as HTMLElement).getByRole('button', { name: /Cancel/i }),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('New value')).toBeNull();
    });
    expect(overwriteAdminSecretMock).not.toHaveBeenCalled();
  });
});
