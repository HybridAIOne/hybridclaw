import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminModelsResponse,
  AdminOutputGuardPreviewResponse,
  AdminOutputGuardProfileResponse,
  AdminOutputGuardProfileUpdateResponse,
} from '../api/types';
import { ToastProvider } from '../components/toast';
import { OutputGuardPage } from './output-guard';

const fetchOutputGuardProfileMock =
  vi.fn<() => Promise<AdminOutputGuardProfileResponse>>();
const fetchModelsMock = vi.fn<() => Promise<AdminModelsResponse>>();
const saveOutputGuardProfileMock =
  vi.fn<
    (...args: unknown[]) => Promise<AdminOutputGuardProfileUpdateResponse>
  >();
const previewOutputGuardProfileMock =
  vi.fn<(...args: unknown[]) => Promise<AdminOutputGuardPreviewResponse>>();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchOutputGuardProfile: () => fetchOutputGuardProfileMock(),
  fetchModels: () => fetchModelsMock(),
  previewOutputGuardProfile: (...args: unknown[]) =>
    previewOutputGuardProfileMock(...args),
  saveOutputGuardProfile: (...args: unknown[]) =>
    saveOutputGuardProfileMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function renderOutputGuardPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <OutputGuardPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthMock.mockReturnValue({ token: 'admin-token' });
  fetchOutputGuardProfileMock.mockResolvedValue({
    profile: {
      enabled: true,
      mode: 'rewrite',
      policy: 'Clear, direct, concrete. No hype.',
      doList: ['Use concrete nouns'],
      dontList: ['Use vague claims'],
      bannedPhrases: ['game changing'],
      bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
      requirePhrases: ['Best regards'],
      classifier: {
        provider: 'default',
        model: '',
      },
      rewriter: {
        provider: 'default',
        model: '',
      },
    },
    revisions: [
      {
        id: 7,
        createdAt: '2026-05-21T10:00:00.000Z',
        actor: 'operator',
        route: 'api.admin.output-guard.profile',
        source: 'admin-console',
        md5: 'abc123',
      },
    ],
  });
  saveOutputGuardProfileMock.mockResolvedValue({
    changed: true,
    reloadMessage: 'Plugin runtime reloaded.',
    profile: {
      enabled: true,
      mode: 'rewrite',
      policy: 'Clear, direct, concrete. No hype.',
      doList: ['Use concrete nouns', 'Prefer short sentences'],
      dontList: ['Use vague claims'],
      bannedPhrases: ['game changing'],
      bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
      requirePhrases: ['Best regards'],
      classifier: {
        provider: 'auxiliary',
        model: '',
      },
      rewriter: {
        provider: 'default',
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
  previewOutputGuardProfileMock.mockResolvedValue({
    score: 58,
    ruleScore: 58,
    scoreSource: 'rules',
    verdict: 'non_compliant',
    violations: [{ kind: 'banned_phrase', detail: 'game changing' }],
    classifier: {
      provider: 'default',
      status: 'evaluated',
      verdict: 'compliant',
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

describe('OutputGuardPage', () => {
  it('edits profile lists and scores a pasted sample', async () => {
    renderOutputGuardPage();

    expect(await screen.findByDisplayValue('Use concrete nouns')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Do item' }));
    const doInputs = screen.getAllByPlaceholderText('Use concrete nouns');
    fireEvent.change(doInputs[1], {
      target: { value: 'Prefer short sentences' },
    });
    fireEvent.click(
      within(
        screen.getByRole('group', {
          name: 'Output guard classifier source',
        }),
      ).getByRole('button', { name: 'aux model' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(saveOutputGuardProfileMock).toHaveBeenCalledWith(
        'admin-token',
        expect.objectContaining({
          doList: ['Use concrete nouns', 'Prefer short sentences'],
          classifier: expect.objectContaining({
            provider: 'auxiliary',
            model: '',
          }),
          rewriter: expect.objectContaining({
            provider: 'default',
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
      expect(previewOutputGuardProfileMock).toHaveBeenCalledWith(
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
    expect(screen.getByText('58/100, non-compliant (rules)')).toBeTruthy();
    expect(
      screen.getByText(
        'Classifier default model via hybridai/default-chat: compliant, low.',
      ),
    ).toBeTruthy();
  });

  it('shows model selectors only for selected other models', async () => {
    renderOutputGuardPage();

    expect(await screen.findByDisplayValue('Use concrete nouns')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Switch model' })).toBeNull();

    fireEvent.click(
      within(
        screen.getByRole('group', {
          name: 'Output guard classifier source',
        }),
      ).getByRole('button', { name: 'other model' }),
    );

    expect(screen.getByRole('combobox', { name: 'Switch model' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(saveOutputGuardProfileMock).toHaveBeenCalledWith(
        'admin-token',
        expect.objectContaining({
          classifier: {
            provider: 'model',
            model: 'openai/gpt-5-mini',
          },
          rewriter: {
            provider: 'default',
            model: '',
          },
        }),
      ),
    );
  });
});
