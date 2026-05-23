import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminBrandVoicePreviewResponse,
  AdminBrandVoiceProfileResponse,
  AdminBrandVoiceProfileUpdateResponse,
  AdminModelsResponse,
} from '../api/types';
import { ToastProvider } from '../components/toast';
import { BrandVoicePage } from './brand-voice';

const fetchBrandVoiceProfileMock =
  vi.fn<() => Promise<AdminBrandVoiceProfileResponse>>();
const fetchModelsMock = vi.fn<() => Promise<AdminModelsResponse>>();
const saveBrandVoiceProfileMock =
  vi.fn<
    (...args: unknown[]) => Promise<AdminBrandVoiceProfileUpdateResponse>
  >();
const previewBrandVoiceProfileMock =
  vi.fn<(...args: unknown[]) => Promise<AdminBrandVoicePreviewResponse>>();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchBrandVoiceProfile: () => fetchBrandVoiceProfileMock(),
  fetchModels: () => fetchModelsMock(),
  previewBrandVoiceProfile: (...args: unknown[]) =>
    previewBrandVoiceProfileMock(...args),
  saveBrandVoiceProfile: (...args: unknown[]) =>
    saveBrandVoiceProfileMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function renderBrandVoicePage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrandVoicePage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthMock.mockReturnValue({ token: 'admin-token' });
  fetchBrandVoiceProfileMock.mockResolvedValue({
    profile: {
      enabled: true,
      mode: 'rewrite',
      voice: 'Clear, direct, concrete. No hype.',
      doList: ['Use concrete nouns'],
      dontList: ['Use vague claims'],
      bannedPhrases: ['game changing'],
      bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
      requirePhrases: ['Best regards'],
      classifier: {
        provider: 'default',
        model: '',
      },
    },
    revisions: [
      {
        id: 7,
        createdAt: '2026-05-21T10:00:00.000Z',
        actor: 'operator',
        route: 'api.admin.brand-voice.profile',
        source: 'admin-console',
        md5: 'abc123',
      },
    ],
  });
  saveBrandVoiceProfileMock.mockResolvedValue({
    changed: true,
    reloadMessage: 'Plugin runtime reloaded.',
    profile: {
      enabled: true,
      mode: 'rewrite',
      voice: 'Clear, direct, concrete. No hype.',
      doList: ['Use concrete nouns', 'Prefer short sentences'],
      dontList: ['Use vague claims'],
      bannedPhrases: ['game changing'],
      bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
      requirePhrases: ['Best regards'],
      classifier: {
        provider: 'auxiliary',
        model: '',
      },
    },
    revisions: [],
  });
  fetchModelsMock.mockResolvedValue({
    defaultModel: 'hybridai/default-chat',
    providerStatus: {},
    models: [
      {
        id: 'hybridai/default-chat',
        provider: 'hybridai',
        backend: null,
        contextWindow: 128000,
        isReasoning: false,
        family: 'gpt',
        parameterSize: null,
        discovered: true,
        maxTokens: null,
        pricingUsdPerToken: { input: null, output: null },
        capabilities: {
          vision: false,
          tools: true,
          jsonMode: true,
          reasoning: false,
        },
        metadataSources: [],
        thinkingFormat: null,
        usageDaily: null,
        usageMonthly: null,
      },
      {
        id: 'openai/gpt-5-mini',
        provider: 'openai',
        backend: null,
        contextWindow: 128000,
        isReasoning: false,
        family: 'gpt',
        parameterSize: null,
        discovered: true,
        maxTokens: null,
        pricingUsdPerToken: { input: null, output: null },
        capabilities: {
          vision: false,
          tools: true,
          jsonMode: true,
          reasoning: false,
        },
        metadataSources: [],
        thinkingFormat: null,
        usageDaily: null,
        usageMonthly: null,
      },
    ],
  });
  previewBrandVoiceProfileMock.mockResolvedValue({
    score: 58,
    ruleScore: 58,
    scoreSource: 'rules',
    verdict: 'off_brand',
    violations: [{ kind: 'banned_phrase', detail: 'game changing' }],
    classifier: {
      provider: 'default',
      status: 'evaluated',
      verdict: 'on_brand',
      severity: 'low',
      reasons: [],
      message: null,
      model: 'hybridai/default-chat',
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BrandVoicePage', () => {
  it('edits profile lists and scores a pasted sample', async () => {
    renderBrandVoicePage();

    expect(await screen.findByDisplayValue('Use concrete nouns')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Do item' }));
    const doInputs = screen.getAllByPlaceholderText('Use concrete nouns');
    fireEvent.change(doInputs[1], {
      target: { value: 'Prefer short sentences' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'aux model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(saveBrandVoiceProfileMock).toHaveBeenCalledWith(
        'admin-token',
        expect.objectContaining({
          doList: ['Use concrete nouns', 'Prefer short sentences'],
          classifier: expect.objectContaining({
            provider: 'auxiliary',
            model: '',
          }),
        }),
      ),
    );

    fireEvent.change(screen.getByPlaceholderText('Paste assistant output'), {
      target: { value: 'This is game changing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Score sample' }));

    await waitFor(() =>
      expect(previewBrandVoiceProfileMock).toHaveBeenCalledWith(
        'admin-token',
        expect.objectContaining({
          bannedPhrases: ['game changing'],
        }),
        'This is game changing.',
      ),
    );
    expect(
      await screen.findByText('Contains banned phrase "game changing".'),
    ).toBeTruthy();
    expect(screen.getByText('58/100, off brand (rules)')).toBeTruthy();
    expect(
      screen.getByText(
        'Classifier default model via hybridai/default-chat: on brand, low.',
      ),
    ).toBeTruthy();
  });

  it('shows the model selector only for other classifier model', async () => {
    renderBrandVoicePage();

    expect(await screen.findByDisplayValue('Use concrete nouns')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Switch model' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'other model' }));

    expect(screen.getByRole('combobox', { name: 'Switch model' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(saveBrandVoiceProfileMock).toHaveBeenCalledWith(
        'admin-token',
        expect.objectContaining({
          classifier: {
            provider: 'model',
            model: 'openai/gpt-5-mini',
          },
        }),
      ),
    );
  });
});
