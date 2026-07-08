import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminApiTokenCreatePayload,
  AdminApiTokenCreateResponse,
  AdminApiTokenEntry,
  AdminApiTokensResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { TokensPage } from './tokens';

const fetchAdminApiTokensMock = vi.fn<() => Promise<AdminApiTokensResponse>>();
const createAdminApiTokenMock =
  vi.fn<
    (
      token: string,
      payload: AdminApiTokenCreatePayload,
    ) => Promise<AdminApiTokenCreateResponse>
  >();
const revokeAdminApiTokenMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchAdminApiTokens: () => fetchAdminApiTokensMock(),
    createAdminApiToken: (token: string, payload: AdminApiTokenCreatePayload) =>
      createAdminApiTokenMock(token, payload),
    revokeAdminApiToken: (token: string, id: string) =>
      revokeAdminApiTokenMock(token, id),
  };
});

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeToken(
  overrides: Partial<AdminApiTokenEntry> = {},
): AdminApiTokenEntry {
  return {
    id: 'tok_123',
    label: 'SDK token',
    claims: { actions: ['openai.api'] },
    created_at: '2026-07-08T10:00:00.000Z',
    created_by: 'admin-user',
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<AdminApiTokensResponse> = {},
): AdminApiTokensResponse {
  return {
    tokens: [],
    total: 0,
    actions: [
      'admin.tokens.read',
      'admin.tokens.create',
      'admin.tokens.revoke',
    ],
    ...overrides,
  };
}

describe('TokensPage', () => {
  beforeEach(() => {
    fetchAdminApiTokensMock.mockReset();
    createAdminApiTokenMock.mockReset();
    revokeAdminApiTokenMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
  });

  it('creates a token from selected actions and a role preset', async () => {
    fetchAdminApiTokensMock.mockResolvedValue(makeResponse());
    createAdminApiTokenMock.mockResolvedValue({
      token: 'hck_token_value',
      apiToken: makeToken({
        claims: {
          actions: ['openai.api', 'chat.send'],
          role: 'admin:auditor',
        },
      }),
    });

    renderWithProviders(<TokensPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create token' }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Create API token' });
    fireEvent.change(within(dialog).getByLabelText('Label'), {
      target: { value: 'SDK token' },
    });

    fireEvent.click(within(dialog).getByLabelText('Actions'));
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /OpenAI API/i }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Chat send/i }));

    fireEvent.change(within(dialog).getByLabelText('Role'), {
      target: { value: 'admin:auditor' },
    });

    const expiresSelect = within(dialog).getByLabelText(
      'Expires at',
    ) as HTMLSelectElement;
    expect([...expiresSelect.options].map((option) => option.value)).toEqual([
      'never',
      '7d',
      '30d',
      '90d',
      'custom',
    ]);
    fireEvent.change(expiresSelect, {
      target: { value: 'custom' },
    });
    fireEvent.change(within(dialog).getByLabelText('Custom expiration'), {
      target: { value: '2026-09-01T08:30' },
    });

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create token' }),
    );

    await waitFor(() =>
      expect(createAdminApiTokenMock).toHaveBeenCalledWith('test-token', {
        label: 'SDK token',
        actions: ['openai.api', 'chat.send'],
        role: 'admin:auditor',
        expiresAt: '2026-09-01T08:30',
      }),
    );
  });
});
