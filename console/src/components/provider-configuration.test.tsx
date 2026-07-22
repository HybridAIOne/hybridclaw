import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminConfig,
  AdminConfigResponse,
  AdminSecretsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ProviderConfiguration } from './provider-configuration';

const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const fetchAdminSecretsMock = vi.fn<() => Promise<AdminSecretsResponse>>();
const saveConfigMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminSecrets: () => fetchAdminSecretsMock(),
  fetchConfig: () => fetchConfigMock(),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

function makeConfig(): AdminConfig {
  return {
    version: 36,
    openai: {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      models: ['openai/gpt-5'],
    },
  } as unknown as AdminConfig;
}

describe('ProviderConfiguration', () => {
  beforeEach(() => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({ path: '/tmp/config.json', config });
    fetchAdminSecretsMock.mockResolvedValue({
      secrets: [
        {
          name: 'OPENAI_API_KEY',
          state: 'set',
          created_at: null,
          last_rotated_at: null,
          length: 16,
          fingerprint: { length: 16, sha256_prefix: 'example' },
        },
      ],
      total: 1,
      actions: ['secret.list_metadata'],
    });
    saveConfigMock.mockImplementation((_token: string, next: AdminConfig) =>
      Promise.resolve({ path: '/tmp/config.json', config: next }),
    );
  });

  it('edits provider enablement and endpoint from the Providers page', async () => {
    renderWithProviders(
      <ProviderConfiguration
        filter=""
        statuses={[
          [
            'openai',
            {
              kind: 'remote',
              reachable: false,
              detail: 'Not authenticated',
              modelCount: 1,
            },
          ],
        ]}
      />,
    );

    expect(await screen.findByText('OpenAI')).toBeTruthy();
    const credential = screen.getByLabelText(
      'API key secret',
    ) as HTMLSelectElement;
    expect(credential.value).toBe('OPENAI_API_KEY');
    expect(credential.disabled).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: 'Enable OpenAI' }));
    fireEvent.change(screen.getByLabelText('OpenAI base URL'), {
      target: { value: 'https://gateway.example/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save providers' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        openai: expect.objectContaining({
          enabled: true,
          baseUrl: 'https://gateway.example/v1',
        }),
      }),
    );
  });
});
