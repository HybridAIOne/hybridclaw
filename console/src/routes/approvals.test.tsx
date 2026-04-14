import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminApprovalsResponse, AdminPolicyState } from '../api/types';
import { ToastProvider } from '../components/toast';
import { ApprovalsPage } from './approvals';

const fetchAdminApprovalsMock =
  vi.fn<
    (
      token: string,
      params?: { agentId?: string },
    ) => Promise<AdminApprovalsResponse>
  >();
const saveAdminPolicyRuleMock =
  vi.fn<
    (
      token: string,
      params: {
        agentId: string;
        index?: number;
        rule: {
          action: 'allow' | 'deny';
          host: string;
          port: number | '*';
          methods: string[];
          paths: string[];
          agent: string;
          comment?: string;
        };
      },
    ) => Promise<AdminPolicyState>
  >();
const saveAdminPolicyDefaultMock =
  vi.fn<
    (
      token: string,
      params: { agentId: string; defaultAction: 'allow' | 'deny' },
    ) => Promise<AdminPolicyState>
  >();
const saveAdminPolicyPresetMock =
  vi.fn<
    (
      token: string,
      params: { agentId: string; presetName: string },
    ) => Promise<AdminPolicyState>
  >();
const deleteAdminPolicyRuleMock =
  vi.fn<
    (
      token: string,
      params: { agentId: string; index: number },
    ) => Promise<AdminPolicyState>
  >();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  deleteAdminPolicyRule: (
    token: string,
    params: { agentId: string; index: number },
  ) => deleteAdminPolicyRuleMock(token, params),
  fetchAdminApprovals: (token: string, params?: { agentId?: string }) =>
    fetchAdminApprovalsMock(token, params),
  saveAdminPolicyRule: (
    token: string,
    params: {
      agentId: string;
      index?: number;
      rule: {
        action: 'allow' | 'deny';
        host: string;
        port: number | '*';
        methods: string[];
        paths: string[];
        agent: string;
        comment?: string;
      };
    },
  ) => saveAdminPolicyRuleMock(token, params),
  saveAdminPolicyDefault: (
    token: string,
    params: { agentId: string; defaultAction: 'allow' | 'deny' },
  ) => saveAdminPolicyDefaultMock(token, params),
  saveAdminPolicyPreset: (
    token: string,
    params: { agentId: string; presetName: string },
  ) => saveAdminPolicyPresetMock(token, params),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeApprovalsResponse(
  overrides: Partial<AdminApprovalsResponse> = {},
): AdminApprovalsResponse {
  return {
    selectedAgentId: 'main',
    agents: [
      {
        id: 'main',
        name: 'Main Agent',
        workspacePath: '/tmp/main/workspace',
      },
      {
        id: 'research',
        name: 'Research',
        workspacePath: '/tmp/research/workspace',
      },
    ],
    pending: [
      {
        sessionId: 'agent:main:channel:web:chat:dm:peer:default',
        agentId: 'main',
        approvalId: 'approve-1',
        userId: 'user-a',
        prompt: 'Approval required for https://example.com',
        createdAt: '2026-04-14T10:00:00.000Z',
        expiresAt: '2026-04-14T10:02:00.000Z',
        allowSession: true,
        allowAgent: true,
        allowAll: true,
        actionKey: 'network:example.com',
      },
    ],
    policy: {
      exists: true,
      policyPath: '/tmp/main/workspace/.hybridclaw/policy.yaml',
      workspacePath: '/tmp/main/workspace',
      defaultAction: 'deny',
      presets: ['github'],
      rules: [
        {
          index: 1,
          action: 'allow',
          host: 'example.com',
          port: '*',
          methods: ['*'],
          paths: ['/**'],
          agent: 'main',
          comment: 'manual allow',
        },
      ],
    },
    availablePresets: [
      {
        name: 'github',
        description: 'GitHub API and raw content',
      },
      {
        name: 'npm',
        description: 'npm registry and tarballs',
      },
    ],
    ...overrides,
  };
}

function renderApprovalsPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ApprovalsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ApprovalsPage', () => {
  beforeEach(() => {
    fetchAdminApprovalsMock.mockReset();
    saveAdminPolicyRuleMock.mockReset();
    saveAdminPolicyDefaultMock.mockReset();
    saveAdminPolicyPresetMock.mockReset();
    deleteAdminPolicyRuleMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchAdminApprovalsMock.mockResolvedValue(makeApprovalsResponse());
    saveAdminPolicyRuleMock.mockResolvedValue(makeApprovalsResponse().policy);
    saveAdminPolicyDefaultMock.mockResolvedValue(
      makeApprovalsResponse().policy,
    );
    saveAdminPolicyPresetMock.mockResolvedValue({
      ...makeApprovalsResponse().policy,
      presets: ['github', 'npm'],
      rules: [
        ...makeApprovalsResponse().policy.rules,
        {
          index: 2,
          action: 'allow',
          host: 'registry.npmjs.org',
          port: '*',
          methods: ['*'],
          paths: ['/**'],
          agent: '*',
          comment: 'preset rule',
          managedByPreset: 'npm',
        },
      ],
    });
    deleteAdminPolicyRuleMock.mockResolvedValue({
      ...makeApprovalsResponse().policy,
      rules: [],
    });
  });

  it('renders pending approvals and the selected agent policy', async () => {
    renderApprovalsPage();

    expect(
      await screen.findByText('Approval required for https://example.com'),
    ).toBeTruthy();
    expect(screen.getByText('network:example.com')).toBeTruthy();
    expect(screen.getByText('manual allow')).toBeTruthy();
  });

  it('refetches policy when the selected agent changes', async () => {
    fetchAdminApprovalsMock
      .mockResolvedValueOnce(makeApprovalsResponse())
      .mockResolvedValueOnce(
        makeApprovalsResponse({
          selectedAgentId: 'research',
          policy: {
            exists: false,
            policyPath: '/tmp/research/workspace/.hybridclaw/policy.yaml',
            workspacePath: '/tmp/research/workspace',
            defaultAction: 'deny',
            presets: [],
            rules: [
              {
                index: 1,
                action: 'allow',
                host: 'api.github.com',
                port: 443,
                methods: ['GET'],
                paths: ['/**'],
                agent: 'research',
              },
            ],
          },
        }),
      );

    renderApprovalsPage();

    await screen.findByText('manual allow');
    fireEvent.change(screen.getByDisplayValue('Main Agent (main)'), {
      target: { value: 'research' },
    });

    await waitFor(() => {
      expect(fetchAdminApprovalsMock).toHaveBeenLastCalledWith('test-token', {
        agentId: 'research',
      });
    });
    expect(await screen.findByText('api.github.com')).toBeTruthy();
  });

  it('adds a policy rule from the editor', async () => {
    renderApprovalsPage();

    await screen.findByText('manual allow');
    expect(screen.queryByLabelText('Host')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));

    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'api.openai.com' },
    });
    fireEvent.change(screen.getByLabelText('Methods'), {
      target: { value: 'GET, POST' },
    });
    fireEvent.change(screen.getByLabelText('Comment'), {
      target: { value: 'Admin add' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(saveAdminPolicyRuleMock).toHaveBeenCalledWith('test-token', {
        agentId: 'main',
        rule: {
          action: 'allow',
          host: 'api.openai.com',
          port: '*',
          methods: ['GET', 'POST'],
          paths: ['/**'],
          agent: 'main',
          comment: 'Admin add',
        },
      });
    });
  });

  it('updates the default policy from the dropdown', async () => {
    renderApprovalsPage();

    await screen.findByText('manual allow');
    fireEvent.change(screen.getByDisplayValue('deny'), {
      target: { value: 'allow' },
    });

    await waitFor(() => {
      expect(saveAdminPolicyDefaultMock).toHaveBeenCalledWith('test-token', {
        agentId: 'main',
        defaultAction: 'allow',
      });
    });
  });

  it('applies a template from the dropdown', async () => {
    renderApprovalsPage();

    await screen.findByText('manual allow');
    fireEvent.change(screen.getByDisplayValue('npm'), {
      target: { value: 'npm' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add template' }));

    await waitFor(() => {
      expect(saveAdminPolicyPresetMock).toHaveBeenCalledWith('test-token', {
        agentId: 'main',
        presetName: 'npm',
      });
    });
  });

  it('edits and deletes policy rules from the table', async () => {
    renderApprovalsPage();

    await screen.findByText('manual allow');
    expect(screen.queryByLabelText('Comment')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    fireEvent.change(screen.getByLabelText('Comment'), {
      target: { value: 'Edited in admin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(saveAdminPolicyRuleMock).toHaveBeenCalledWith('test-token', {
        agentId: 'main',
        index: 1,
        rule: {
          action: 'allow',
          host: 'example.com',
          port: '*',
          methods: ['*'],
          paths: ['/**'],
          agent: 'main',
          comment: 'Edited in admin',
        },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('This will remove rule #1 for example.com.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteAdminPolicyRuleMock).toHaveBeenCalledWith('test-token', {
        agentId: 'main',
        index: 1,
      });
    });
  });

  it('does not delete a policy rule when confirmation is cancelled', async () => {
    renderApprovalsPage();

    await screen.findByText('manual allow');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(deleteAdminPolicyRuleMock).not.toHaveBeenCalled();
  });
});
