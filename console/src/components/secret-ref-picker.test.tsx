import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSecretsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { Field, FieldLabel } from './field';
import { SecretRefPicker } from './secret-ref-picker';

const fetchAdminSecretsMock = vi.fn<() => Promise<AdminSecretsResponse>>();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminSecrets: () => fetchAdminSecretsMock(),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function renderPicker(value = '', onValueChange = vi.fn()) {
  renderWithProviders(
    <Field>
      <FieldLabel>API key secret</FieldLabel>
      <SecretRefPicker value={value} onValueChange={onValueChange} />
    </Field>,
  );
}

describe('SecretRefPicker', () => {
  beforeEach(() => {
    fetchAdminSecretsMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchAdminSecretsMock.mockResolvedValue({
      secrets: [
        {
          name: 'ZETA_KEY',
          state: 'unset',
          created_at: null,
          last_rotated_at: null,
          length: null,
          fingerprint: null,
        },
        {
          name: 'ALPHA_KEY',
          state: 'set',
          created_at: '2026-07-18T10:00:00.000Z',
          last_rotated_at: '2026-07-18T10:00:00.000Z',
          length: 32,
          fingerprint: { length: 32, sha256_prefix: 'not-rendered' },
        },
      ],
      total: 2,
      actions: ['secret.list_metadata'],
    });
  });

  it('renders sorted secret names without exposing secret metadata', async () => {
    renderPicker();

    const select = (await screen.findByLabelText(
      'API key secret',
    )) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'ALPHA_KEY' });
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      'Select secret',
      'ALPHA_KEY',
      'ZETA_KEY (unset)',
    ]);
    expect(document.body.textContent).not.toContain('not-rendered');
    expect(document.body.textContent).not.toContain('32');
    expect(
      screen
        .getByRole('link', { name: 'Create new secret →' })
        .getAttribute('href'),
    ).toBe('/admin/secrets');
  });

  it('selects a stored secret name and preserves a missing current reference', async () => {
    const onValueChange = vi.fn();
    renderPicker('LEGACY_KEY', onValueChange);

    const select = (await screen.findByLabelText(
      'API key secret',
    )) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'ALPHA_KEY' });
    expect(select.value).toBe('LEGACY_KEY');
    expect(screen.getByRole('option', { name: 'LEGACY_KEY' })).toBeTruthy();

    fireEvent.change(select, { target: { value: 'ALPHA_KEY' } });
    expect(onValueChange).toHaveBeenCalledWith('ALPHA_KEY');
  });
});
