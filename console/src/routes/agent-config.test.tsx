import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminAgent,
  AdminModelsResponse,
  AdminSkillsResponse,
  AdminToolsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { AgentConfigPage } from './agent-config';

const fetchAdminAgentsMock = vi.fn<() => Promise<AdminAgent[]>>();
const fetchSkillsMock = vi.fn<() => Promise<AdminSkillsResponse>>();
const fetchToolsMock = vi.fn<() => Promise<AdminToolsResponse>>();
const fetchModelsMock = vi.fn<() => Promise<AdminModelsResponse>>();
const updateAdminAgentMock = vi.fn();
const deleteAdminAgentMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminAgents: () => fetchAdminAgentsMock(),
  fetchSkills: () => fetchSkillsMock(),
  fetchTools: () => fetchToolsMock(),
  fetchModels: () => fetchModelsMock(),
  updateAdminAgent: (...args: unknown[]) => updateAdminAgentMock(...args),
  deleteAdminAgent: (...args: unknown[]) => deleteAdminAgentMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeAgent(overrides: Partial<AdminAgent> = {}): AdminAgent {
  return {
    id: 'support',
    archived: false,
    name: 'Support Agent',
    model: null,
    skills: null,
    tools: null,
    chatbotId: null,
    enableRag: null,
    role: null,
    reportsTo: null,
    delegatesTo: null,
    peers: null,
    workspace: null,
    workspacePath: '/tmp/support/workspace',
    markdownFiles: [],
    ...overrides,
  };
}

function makeSkill(name: string, category: string) {
  return {
    name,
    description: `${name} description`,
    category,
    developer: 'HybridClaw',
    source: 'bundled',
    available: true,
    enabled: true,
    missing: [],
    userInvocable: false,
    disableModelInvocation: false,
    always: false,
    capabilities: [],
    supportedChannels: [],
    requires: { bins: [], env: [] },
    tags: [],
  } as unknown as AdminSkillsResponse['skills'][number];
}

function makeTool(name: string) {
  return {
    name,
    group: 'Files',
    kind: 'builtin' as const,
    recentCalls: 0,
    recentErrors: 0,
    lastUsedAt: null,
    recentErrorSamples: [],
  };
}

describe('AgentConfigPage', () => {
  beforeEach(() => {
    fetchAdminAgentsMock.mockReset();
    fetchSkillsMock.mockReset();
    fetchToolsMock.mockReset();
    fetchModelsMock.mockReset();
    updateAdminAgentMock.mockReset();
    deleteAdminAgentMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchAdminAgentsMock.mockResolvedValue([makeAgent()]);
    fetchSkillsMock.mockResolvedValue({
      skills: [makeSkill('pdf', 'documents'), makeSkill('docx', 'documents')],
    } as AdminSkillsResponse);
    fetchToolsMock.mockResolvedValue({
      totals: {
        totalTools: 2,
        builtinTools: 2,
        mcpTools: 0,
        otherTools: 0,
        recentExecutions: 0,
        recentErrors: 0,
      },
      groups: [{ label: 'Files', tools: [makeTool('read'), makeTool('bash')] }],
      recentExecutions: [],
    });
    fetchModelsMock.mockResolvedValue({
      defaultModel: 'gpt-5',
      providerStatus: {},
      models: [],
    } as unknown as AdminModelsResponse);
  });

  it('lists agents to pick from when none is selected', async () => {
    renderWithProviders(<AgentConfigPage onAgentChange={() => {}} />);

    expect(await screen.findByText('Support Agent')).toBeTruthy();
    expect(screen.getByText('all skills')).toBeTruthy();
    expect(screen.getByText('all tools')).toBeTruthy();
  });

  it('narrows an unrestricted allowlist when a tool is unchecked', async () => {
    updateAdminAgentMock.mockResolvedValue(makeAgent({ tools: ['read'] }));
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    const bash = await screen.findByRole('checkbox', { name: 'bash' });
    fireEvent.click(bash);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'support',
        expect.objectContaining({ tools: ['read'], skills: null }),
      );
    });
  });

  it('sends null when an allowlist is reset to everything', async () => {
    fetchAdminAgentsMock.mockResolvedValue([makeAgent({ skills: ['pdf'] })]);
    updateAdminAgentMock.mockResolvedValue(makeAgent());
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    const resetButtons = await screen.findAllByRole('button', {
      name: 'Reset to all',
    });
    fireEvent.click(resetButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'support',
        expect.objectContaining({ skills: null }),
      );
    });
  });
});
