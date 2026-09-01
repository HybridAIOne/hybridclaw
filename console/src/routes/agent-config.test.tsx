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

  it('starts empty when restricting and adds entries via the palette', async () => {
    updateAdminAgentMock.mockResolvedValue(makeAgent({ tools: ['read'] }));
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    const restrictToggles = await screen.findAllByRole('button', {
      name: /Selected only/,
    });
    fireEvent.click(restrictToggles[1]);
    expect(screen.getByText(/Nothing selected/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add tools…' }));
    fireEvent.click(await screen.findByRole('option', { name: /read/ }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search tools' }), {
      key: 'Escape',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'support',
        expect.objectContaining({ tools: ['read'], skills: null }),
      );
    });
  });

  it('restores the stashed selection when flipping back to selected only', async () => {
    fetchAdminAgentsMock.mockResolvedValue([makeAgent({ tools: ['read'] })]);
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    expect(await screen.findByRole('button', { name: 'Remove read' }));
    fireEvent.click(screen.getByRole('button', { name: /All tools/ }));
    expect(screen.queryByRole('button', { name: 'Remove read' })).toBeNull();

    const restrictToggles = screen.getAllByRole('button', {
      name: /Selected only/,
    });
    fireEvent.click(restrictToggles[1]);
    expect(screen.getByRole('button', { name: 'Remove read' })).toBeTruthy();
  });

  it('adds a catalog entry through the search palette', async () => {
    fetchAdminAgentsMock.mockResolvedValue([makeAgent({ tools: ['read'] })]);
    updateAdminAgentMock.mockResolvedValue(
      makeAgent({ tools: ['read', 'bash'] }),
    );
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add tools…' }));
    fireEvent.click(await screen.findByRole('option', { name: /bash/ }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search tools' }), {
      key: 'Escape',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'support',
        expect.objectContaining({ tools: ['read', 'bash'] }),
      );
    });
  });

  it('adds a custom tool by exact name through the palette', async () => {
    fetchAdminAgentsMock.mockResolvedValue([makeAgent({ tools: ['read'] })]);
    updateAdminAgentMock.mockResolvedValue(
      makeAgent({ tools: ['read', 'github__create_issue'] }),
    );
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add tools…' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search tools' }), {
      target: { value: 'github__create_issue' },
    });
    fireEvent.click(
      screen.getByRole('option', { name: /Add “github__create_issue”/ }),
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search tools' }), {
      key: 'Escape',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'support',
        expect.objectContaining({ tools: ['read', 'github__create_issue'] }),
      );
    });
  });

  it('sends null when an allowlist is reset to everything', async () => {
    fetchAdminAgentsMock.mockResolvedValue([makeAgent({ skills: ['pdf'] })]);
    updateAdminAgentMock.mockResolvedValue(makeAgent());
    renderWithProviders(
      <AgentConfigPage selectedAgentId="support" onAgentChange={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /All skills/ }));
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
