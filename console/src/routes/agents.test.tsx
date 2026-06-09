import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminAgent,
  AdminAgentMarkdownFileResponse,
  AdminAgentMarkdownRevision,
  AdminAgentMarkdownRevisionResponse,
  AdminTeamStructureRevision,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { AgentFilesPage } from './agents';

const fetchAdminAgentsMock = vi.fn<() => Promise<AdminAgent[]>>();
const fetchAdminAgentMarkdownFileMock =
  vi.fn<
    (
      token: string,
      params: { agentId: string; fileName: string },
    ) => Promise<AdminAgentMarkdownFileResponse>
  >();
const fetchAdminAgentMarkdownRevisionMock =
  vi.fn<
    (
      token: string,
      params: { agentId: string; fileName: string; revisionId: string },
    ) => Promise<AdminAgentMarkdownRevisionResponse>
  >();
const fetchAdminTeamStructureMock = vi.fn();
const fetchAdminTeamStructureRevisionMock = vi.fn();
const restoreAdminTeamStructureRevisionMock = vi.fn();
const restoreAdminAgentMarkdownRevisionMock = vi.fn();
const saveAdminAgentMarkdownFileMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminAgents: () => fetchAdminAgentsMock(),
  fetchAdminAgentMarkdownFile: (
    token: string,
    params: { agentId: string; fileName: string },
  ) => fetchAdminAgentMarkdownFileMock(token, params),
  fetchAdminAgentMarkdownRevision: (
    token: string,
    params: { agentId: string; fileName: string; revisionId: string },
  ) => fetchAdminAgentMarkdownRevisionMock(token, params),
  fetchAdminTeamStructure: (token: string) =>
    fetchAdminTeamStructureMock(token),
  fetchAdminTeamStructureRevision: (token: string, revisionId: number) =>
    fetchAdminTeamStructureRevisionMock(token, revisionId),
  restoreAdminAgentMarkdownRevision: (
    token: string,
    params: { agentId: string; fileName: string; revisionId: string },
  ) => restoreAdminAgentMarkdownRevisionMock(token, params),
  restoreAdminTeamStructureRevision: (token: string, revisionId: number) =>
    restoreAdminTeamStructureRevisionMock(token, revisionId),
  saveAdminAgentMarkdownFile: (
    token: string,
    params: { agentId: string; fileName: string; content: string },
  ) => saveAdminAgentMarkdownFileMock(token, params),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeAgent(overrides: Partial<AdminAgent>): AdminAgent {
  return {
    id: 'main',
    name: 'Main Agent',
    model: 'gpt-5',
    skills: null,
    chatbotId: null,
    enableRag: true,
    role: null,
    reportsTo: null,
    delegatesTo: null,
    peers: null,
    workspace: null,
    workspacePath: '/tmp/main/workspace',
    markdownFiles: [
      {
        name: 'AGENTS.md',
        path: '/tmp/main/workspace/AGENTS.md',
        exists: true,
        updatedAt: '2026-04-13T10:00:00.000Z',
        sizeBytes: 120,
      },
      {
        name: 'USER.md',
        path: '/tmp/main/workspace/USER.md',
        exists: false,
        updatedAt: null,
        sizeBytes: null,
      },
    ],
    ...overrides,
  };
}

function makeDocument(
  agent: AdminAgent,
  fileName: string,
  content: string,
  revisions: AdminAgentMarkdownRevision[] = [
    {
      id: 'rev-1',
      createdAt: '2026-04-13T09:00:00.000Z',
      sizeBytes: 80,
      sha256: 'abc123',
      source: 'save',
    },
  ],
): AdminAgentMarkdownFileResponse {
  const file =
    agent.markdownFiles.find((entry) => entry.name === fileName) ||
    agent.markdownFiles[0];
  if (!file) {
    throw new Error(`Missing file ${fileName}`);
  }
  return {
    agent,
    file: {
      ...file,
      content,
      revisions,
    },
  };
}

function makeMarkdownRevisions(count: number): AdminAgentMarkdownRevision[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `rev-${index + 1}`,
    createdAt: `2026-04-13T09:${String(index).padStart(2, '0')}:00.000Z`,
    sizeBytes: 1000 + index,
    sha256: `sha-${index + 1}`,
    source: 'save',
  }));
}

function makeTeamRevisions(count: number): AdminTeamStructureRevision[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    createdAt: `2026-04-13T10:${String(index).padStart(2, '0')}:00.000Z`,
    actor: 'admin',
    route: `/admin/team/${index + 1}`,
    source: 'save',
    md5: `md5-${index + 1}`,
    sizeBytes: 100 + index,
    replacedByMd5: null,
    changeCount: index + 1,
    diff: {
      added: [],
      removed: [],
      changed: [],
    },
  }));
}

function renderPage() {
  const { queryClient } = renderWithProviders(<AgentFilesPage />);
  return queryClient;
}

describe('AgentFilesPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/agents');
    fetchAdminAgentsMock.mockReset();
    fetchAdminAgentMarkdownFileMock.mockReset();
    fetchAdminAgentMarkdownRevisionMock.mockReset();
    fetchAdminTeamStructureMock.mockReset();
    fetchAdminTeamStructureRevisionMock.mockReset();
    restoreAdminTeamStructureRevisionMock.mockReset();
    restoreAdminAgentMarkdownRevisionMock.mockReset();
    saveAdminAgentMarkdownFileMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      token: 'test-token',
    });
    fetchAdminTeamStructureMock.mockResolvedValue({
      snapshot: { version: 1, agents: [{ id: 'main' }] },
      revisions: [],
    });
  });

  it('opens the markdown file from the URL query string', async () => {
    window.history.replaceState(
      {},
      '',
      '/admin/agents?agent=charly&file=CV.md',
    );
    const mainAgent = makeAgent({});
    const charlyAgent = makeAgent({
      id: 'charly',
      name: 'Charly',
      workspacePath: '/tmp/charly/workspace',
      markdownFiles: [
        {
          name: 'AGENTS.md',
          path: '/tmp/charly/workspace/AGENTS.md',
          exists: true,
          updatedAt: '2026-04-13T10:00:00.000Z',
          sizeBytes: 120,
        },
        {
          name: 'CV.md',
          path: '/tmp/charly/workspace/CV.md',
          exists: true,
          updatedAt: '2026-04-13T11:00:00.000Z',
          sizeBytes: 80,
        },
      ],
    });
    fetchAdminAgentsMock.mockResolvedValue([mainAgent, charlyAgent]);
    fetchAdminAgentMarkdownFileMock.mockImplementation(async (_token, params) =>
      makeDocument(
        params.agentId === 'charly' ? charlyAgent : mainAgent,
        params.fileName,
        params.fileName === 'CV.md' ? '# Charly CV' : '# Rules',
      ),
    );

    renderPage();

    expect(await screen.findByDisplayValue('# Charly CV')).not.toBeNull();
    expect(fetchAdminAgentMarkdownFileMock).toHaveBeenCalledWith('test-token', {
      agentId: 'charly',
      fileName: 'CV.md',
    });
  });

  it('loads the selected agent markdown file and switches agents', async () => {
    const mainAgent = makeAgent({});
    const writerAgent = makeAgent({
      id: 'writer',
      name: 'Writer',
      model: null,
      workspacePath: '/tmp/writer/workspace',
      markdownFiles: [
        {
          name: 'AGENTS.md',
          path: '/tmp/writer/workspace/AGENTS.md',
          exists: false,
          updatedAt: null,
          sizeBytes: null,
        },
        {
          name: 'USER.md',
          path: '/tmp/writer/workspace/USER.md',
          exists: true,
          updatedAt: '2026-04-13T11:00:00.000Z',
          sizeBytes: 42,
        },
      ],
    });

    fetchAdminAgentsMock.mockResolvedValue([mainAgent, writerAgent]);
    fetchAdminAgentMarkdownFileMock.mockImplementation(
      async (_token, params) =>
        params.agentId === 'writer'
          ? makeDocument(writerAgent, params.fileName, '# Writer Rules')
          : makeDocument(mainAgent, params.fileName, '# Main Rules'),
    );

    renderPage();

    expect(await screen.findByDisplayValue('# Main Rules')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Agent'), {
      target: { value: 'writer' },
    });

    expect(await screen.findByDisplayValue('# Writer Rules')).not.toBeNull();
    expect(fetchAdminAgentMarkdownFileMock).toHaveBeenCalledWith('test-token', {
      agentId: 'writer',
      fileName: 'AGENTS.md',
    });
  });

  it('shows shared cloud memory files as read-only agent files', async () => {
    const agent = makeAgent({
      markdownFiles: [
        {
          name: 'AGENTS.md',
          path: '/tmp/main/workspace/AGENTS.md',
          exists: true,
          updatedAt: '2026-04-13T10:00:00.000Z',
          sizeBytes: 120,
        },
        {
          name: 'Instance Memory.md',
          displayName: 'Instance Memory',
          path: 'cloud-memory://installation/MEMORY.md',
          scope: 'installation',
          cloudPath: '/MEMORY.md',
          readOnly: true,
          exists: true,
          updatedAt: null,
          sizeBytes: 64,
        },
        {
          name: 'Organization Memory.md',
          displayName: 'Organization Memory',
          path: 'cloud-memory://company/MEMORY.md',
          scope: 'company',
          cloudPath: '/MEMORY.md',
          readOnly: true,
          exists: true,
          updatedAt: null,
          sizeBytes: 72,
        },
      ],
    });
    const organizationMemoryFile = agent.markdownFiles.find(
      (file) => file.name === 'Organization Memory.md',
    );
    if (!organizationMemoryFile) {
      throw new Error('Expected organization memory test file.');
    }
    fetchAdminAgentsMock.mockResolvedValue([agent]);
    fetchAdminAgentMarkdownFileMock.mockImplementation(
      async (_token, params) =>
        params.fileName === 'Organization Memory.md'
          ? {
              agent,
              file: {
                ...organizationMemoryFile,
                content: '# Organization Memory',
                revisions: [],
              },
            }
          : makeDocument(agent, params.fileName, '# Main Rules'),
    );

    renderPage();

    await screen.findByDisplayValue('# Main Rules');
    fireEvent.change(screen.getByLabelText('Markdown file'), {
      target: { value: 'Organization Memory.md' },
    });

    const editor = (await screen.findByDisplayValue(
      '# Organization Memory',
    )) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByText('Read-only cloud memory cache.')).not.toBeNull();
    expect(
      screen.getByText(
        'Shared memory files are read-only and do not have local revisions.',
      ),
    ).not.toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Save Markdown',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(fetchAdminAgentMarkdownFileMock).toHaveBeenCalledWith('test-token', {
      agentId: 'main',
      fileName: 'Organization Memory.md',
    });
  });

  it('saves edited markdown content for the selected agent file', async () => {
    const agent = makeAgent({});
    fetchAdminAgentsMock.mockResolvedValue([agent]);
    fetchAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Original Rules'),
    );
    saveAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Updated Rules'),
    );

    renderPage();

    await screen.findByDisplayValue('# Original Rules');
    const editor = (await screen.findByLabelText(
      'AGENTS.md',
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# Updated Rules' } });
    await waitFor(() => expect(editor.value).toBe('# Updated Rules'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Markdown' }));

    await waitFor(() =>
      expect(saveAdminAgentMarkdownFileMock).toHaveBeenCalledWith(
        'test-token',
        {
          agentId: 'main',
          fileName: 'AGENTS.md',
          content: '# Updated Rules',
        },
      ),
    );
    expect(editor.value).toBe('# Updated Rules');
  });

  it('loads and restores a saved markdown revision', async () => {
    const agent = makeAgent({});
    fetchAdminAgentsMock.mockResolvedValue([agent]);
    fetchAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Current Rules'),
    );
    fetchAdminAgentMarkdownRevisionMock.mockResolvedValue({
      agent,
      fileName: 'AGENTS.md',
      revision: {
        id: 'rev-1',
        createdAt: '2026-04-13T09:00:00.000Z',
        sizeBytes: 80,
        sha256: 'abc123',
        source: 'save',
        content: '# Previous Rules',
      },
    });
    restoreAdminAgentMarkdownRevisionMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Previous Rules'),
    );

    renderPage();

    await screen.findByDisplayValue('# Current Rules');
    fireEvent.click(
      screen.getByText(/80 bytes/i).closest('button') as HTMLButtonElement,
    );

    expect(await screen.findByDisplayValue('# Previous Rules')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Version' }));

    await waitFor(() =>
      expect(restoreAdminAgentMarkdownRevisionMock).toHaveBeenCalledWith(
        'test-token',
        {
          agentId: 'main',
          fileName: 'AGENTS.md',
          revisionId: 'rev-1',
        },
      ),
    );
  });

  it('shows only the first 10 markdown revisions until more are requested', async () => {
    const agent = makeAgent({});
    fetchAdminAgentsMock.mockResolvedValue([agent]);
    fetchAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(
        agent,
        'AGENTS.md',
        '# Current Rules',
        makeMarkdownRevisions(12),
      ),
    );

    renderPage();

    await screen.findByDisplayValue('# Current Rules');
    expect(screen.getByText(/1009 bytes/i)).not.toBeNull();
    expect(screen.queryByText(/1010 bytes/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));

    expect(screen.getByText(/1010 bytes/i)).not.toBeNull();
    expect(screen.getByText(/1011 bytes/i)).not.toBeNull();
  });

  it('shows only the first 10 team revisions until more are requested', async () => {
    const agent = makeAgent({});
    fetchAdminAgentsMock.mockResolvedValue([agent]);
    fetchAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Current Rules'),
    );
    fetchAdminTeamStructureMock.mockResolvedValue({
      snapshot: { version: 1, agents: [{ id: 'main' }] },
      revisions: makeTeamRevisions(12),
    });

    renderPage();

    await screen.findByDisplayValue('# Current Rules');
    expect(screen.getByText(/#10/)).not.toBeNull();
    expect(screen.queryByText(/#11/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));

    expect(screen.getByText(/#11/)).not.toBeNull();
    expect(screen.getByText(/#12/)).not.toBeNull();
  });

  it('preserves dirty editor content when the selected file refetches', async () => {
    const agent = makeAgent({});
    fetchAdminAgentsMock.mockResolvedValue([agent]);
    fetchAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Original Rules'),
    );

    const queryClient = renderPage();

    await screen.findByDisplayValue('# Original Rules');
    const editor = (await screen.findByLabelText(
      'AGENTS.md',
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# Draft Rules' } });
    await waitFor(() => expect(editor.value).toBe('# Draft Rules'));

    fetchAdminAgentMarkdownFileMock.mockResolvedValue(
      makeDocument(agent, 'AGENTS.md', '# Refetched Rules'),
    );
    await queryClient.invalidateQueries({
      queryKey: ['admin-agent-markdown', 'test-token', 'main', 'AGENTS.md'],
    });

    await waitFor(() =>
      expect(fetchAdminAgentMarkdownFileMock).toHaveBeenCalledTimes(2),
    );
    expect(editor.value).toBe('# Draft Rules');
  });
});
