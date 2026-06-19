import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminAdaptiveSkillAmendmentsResponse,
  AdminAdaptiveSkillHealthMetric,
  AdminAdaptiveSkillHealthResponse,
  AdminSkill,
  AdminSkillPackageFileResponse,
  AdminSkillPackageFilesResponse,
  AdminSkillsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { SkillDetailView } from './skill-detail';
import { SkillsPage } from './skills';

const fetchSkillsMock = vi.fn<() => Promise<AdminSkillsResponse>>();
const fetchHealthMock =
  vi.fn<() => Promise<AdminAdaptiveSkillHealthResponse>>();
const fetchAmendmentsMock =
  vi.fn<() => Promise<AdminAdaptiveSkillAmendmentsResponse>>();
const fetchSkillPackageFilesMock =
  vi.fn<() => Promise<AdminSkillPackageFilesResponse>>();
const fetchSkillPackageFileMock =
  vi.fn<
    (
      token: string,
      payload: { skillName: string; path: string },
    ) => Promise<AdminSkillPackageFileResponse>
  >();
const saveSkillPackageFileMock =
  vi.fn<
    (
      token: string,
      payload: { skillName: string; path: string; content: string },
    ) => Promise<AdminSkillPackageFileResponse>
  >();
const saveSkillEnabledMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchSkills: () => fetchSkillsMock(),
  fetchAdaptiveSkillHealth: () => fetchHealthMock(),
  fetchAdaptiveSkillAmendments: () => fetchAmendmentsMock(),
  fetchAdaptiveSkillAmendmentHistory: () => fetchAmendmentsMock(),
  fetchSkillPackageFiles: () => fetchSkillPackageFilesMock(),
  fetchSkillPackageFile: (
    token: string,
    payload: { skillName: string; path: string },
  ) => fetchSkillPackageFileMock(token, payload),
  saveSkillPackageFile: (
    token: string,
    payload: { skillName: string; path: string; content: string },
  ) => saveSkillPackageFileMock(token, payload),
  saveSkillEnabled: (
    token: string,
    payload: { name: string; enabled: boolean },
  ) => saveSkillEnabledMock(token, payload),
  createSkill: vi.fn(),
  unblockSkill: vi.fn(),
  uploadSkillZip: vi.fn(),
  applyAdaptiveSkillAmendment: vi.fn(),
  rejectAdaptiveSkillAmendment: vi.fn(),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeSkill(overrides: Partial<AdminSkill> = {}): AdminSkill {
  return {
    name: 'pdf',
    description: 'Create and read PDF files.',
    category: 'office',
    developer: 'HybridClaw',
    source: 'bundled',
    available: true,
    enabled: true,
    missing: [],
    userInvocable: true,
    disableModelInvocation: false,
    always: false,
    capabilities: [],
    supportedChannels: ['discord', 'tui'],
    requires: { bins: [], env: [] },
    tags: [],
    relatedSkills: [],
    install: [],
    credentials: [],
    configVariables: [],
    ...overrides,
  };
}

function makeResponse(skills: AdminSkill[]): AdminSkillsResponse {
  return { extraDirs: [], disabled: [], skills };
}

function makeSkillFileResponse(
  content = '# PDF skill\n',
): AdminSkillPackageFileResponse {
  return {
    skillName: 'pdf',
    rootPath: '/skills/pdf',
    file: {
      path: 'SKILL.md',
      name: 'SKILL.md',
      kind: 'file',
      sizeBytes: content.length,
      updatedAt: '2026-06-19T10:00:00.000Z',
      editable: true,
      previewable: true,
      content,
    },
  };
}

function makeHealthMetric(
  overrides: Partial<AdminAdaptiveSkillHealthMetric> = {},
): AdminAdaptiveSkillHealthMetric {
  return {
    skill_name: 'pdf',
    total_executions: 3,
    success_count: 2,
    partial_count: 1,
    failure_count: 0,
    success_rate: 2 / 3,
    avg_duration_ms: 100,
    error_clusters: [],
    tool_calls_attempted: 4,
    tool_calls_failed: 1,
    tool_breakage_rate: 0.18,
    positive_feedback_count: 0,
    negative_feedback_count: 0,
    degraded: false,
    degradation_reasons: [],
    window_started_at: '2026-05-27T12:00:00.000Z',
    window_ended_at: '2026-05-27T14:00:00.000Z',
    ...overrides,
  };
}

describe('SkillsPage', () => {
  beforeEach(() => {
    fetchSkillsMock.mockReset();
    fetchHealthMock.mockReset();
    fetchAmendmentsMock.mockReset();
    fetchSkillPackageFilesMock.mockReset();
    fetchSkillPackageFileMock.mockReset();
    saveSkillPackageFileMock.mockReset();
    saveSkillEnabledMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchHealthMock.mockResolvedValue({ metrics: [] });
    fetchAmendmentsMock.mockResolvedValue({ amendments: [] });
    fetchSkillPackageFilesMock.mockResolvedValue({
      skillName: 'pdf',
      rootPath: '/skills/pdf',
      files: [],
    });
    fetchSkillPackageFileMock.mockResolvedValue(makeSkillFileResponse());
    saveSkillPackageFileMock.mockResolvedValue(makeSkillFileResponse());
  });

  it('renders the catalog and filters by the search Input', async () => {
    fetchSkillsMock.mockResolvedValue(
      makeResponse([
        makeSkill({ name: 'pdf', description: 'PDF tools.' }),
        makeSkill({ name: 'memory', description: 'Memory utilities.' }),
      ]),
    );

    renderWithProviders(<SkillsPage />);

    expect(await screen.findByText('pdf')).toBeTruthy();
    expect(screen.getByText('memory')).toBeTruthy();

    const filter = screen.getByPlaceholderText(
      'Filter skills',
    ) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'mem' } });

    await waitFor(() => {
      expect(screen.queryByText('pdf')).toBeNull();
    });
    expect(screen.getByText('memory')).toBeTruthy();
  });

  it('links installed skills to their detail pages', async () => {
    fetchSkillsMock.mockResolvedValue(makeResponse([makeSkill()]));

    renderWithProviders(<SkillsPage />);

    const link = await screen.findByRole('link', { name: 'pdf' });
    expect(link.getAttribute('href')).toBe('/admin/skills/pdf');
  });

  it('renders skill detail metadata, docs, and example prompts', async () => {
    fetchSkillsMock.mockResolvedValue(
      makeResponse([
        makeSkill({
          install: [
            {
              id: 'node',
              kind: 'node',
              label: 'Install Node.js',
              bins: ['node'],
            },
          ],
          credentials: [
            {
              id: 'pdf-api-token',
              kind: 'api_key',
              required: true,
              secretRef: { source: 'store', id: 'PDF_API_TOKEN' },
              scope: 'PDF service',
              howToObtain: 'Create a token.',
            },
          ],
          configVariables: [
            {
              id: 'pdf-host',
              env: 'PDF_HOST',
              required: false,
              scope: 'PDF API host',
              howToObtain: 'Set the host.',
            },
          ],
          capabilities: ['document-processing'],
          requires: { bins: ['node'], env: ['PDF_HOST'] },
          tags: ['office'],
          relatedSkills: ['docx'],
          docs: {
            title: 'pdf',
            sourcePath: 'guides/skills/office.md',
            sourceHref: '/docs/guides/skills/office#pdf',
            tutorialMarkdown: '## pdf\n\nRender and inspect PDFs.',
            screenshots: [
              {
                src: '/docs/guides/skills/assets/pdf-preview.png',
                alt: 'PDF workflow preview',
                title: 'PDF preview',
              },
            ],
            examplePrompts: [
              {
                kind: 'try-it',
                prompt: 'Create a one-page PDF titled "Quarterly Report"',
              },
            ],
          },
        }),
      ]),
    );

    renderWithProviders(<SkillDetailView skillName="pdf" />);

    expect(await screen.findByRole('heading', { name: 'pdf' })).toBeTruthy();
    expect(screen.getByText('HybridClaw')).toBeTruthy();
    expect(screen.getByAltText('PDF workflow preview')).toHaveProperty(
      'src',
      expect.stringContaining('/docs/guides/skills/assets/pdf-preview.png'),
    );
    expect(screen.getByText('PDF preview')).toBeTruthy();
    expect(screen.getByText('capability: document-processing')).toBeTruthy();
    expect(screen.getByText('bin: node')).toBeTruthy();
    expect(screen.getByText('Install Node.js')).toBeTruthy();
    expect(screen.getByText('PDF_API_TOKEN')).toBeTruthy();
    expect(screen.getByText('PDF_HOST')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tutorial' }));
    expect(screen.getByText('Render and inspect PDFs.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Prompts' }));
    expect(
      screen.getByText('Create a one-page PDF titled "Quarterly Report"'),
    ).toBeTruthy();
  });

  it('previews installed skill package files', async () => {
    fetchSkillsMock.mockResolvedValue(makeResponse([makeSkill()]));
    fetchSkillPackageFilesMock.mockResolvedValue({
      skillName: 'pdf',
      rootPath: '/skills/pdf',
      files: [
        {
          path: 'references',
          name: 'references',
          kind: 'directory',
          sizeBytes: null,
          updatedAt: '2026-06-19T10:00:00.000Z',
          editable: false,
          previewable: false,
        },
        {
          path: 'SKILL.md',
          name: 'SKILL.md',
          kind: 'file',
          sizeBytes: 12,
          updatedAt: '2026-06-19T10:00:00.000Z',
          editable: true,
          previewable: true,
        },
        {
          path: 'icon.png',
          name: 'icon.png',
          kind: 'file',
          sizeBytes: 1024,
          updatedAt: '2026-06-19T10:00:00.000Z',
          editable: false,
          previewable: false,
        },
      ],
    });
    fetchSkillPackageFileMock.mockResolvedValue(
      makeSkillFileResponse('# PDF\n'),
    );
    saveSkillPackageFileMock.mockResolvedValue(
      makeSkillFileResponse('# Updated PDF\n'),
    );

    renderWithProviders(<SkillDetailView skillName="pdf" />);

    expect(await screen.findByText('/skills/pdf')).toBeTruthy();
    expect(screen.getByText('icon.png')).toBeTruthy();
    const editor = (await screen.findByLabelText(
      'Edit SKILL.md',
    )) as HTMLTextAreaElement;
    expect(editor.value).toBe('# PDF\n');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('toggling a skill calls saveSkillEnabled with the inverted value', async () => {
    fetchSkillsMock.mockResolvedValue(
      makeResponse([makeSkill({ name: 'pdf', enabled: true })]),
    );
    saveSkillEnabledMock.mockResolvedValue(
      makeResponse([makeSkill({ name: 'pdf', enabled: false })]),
    );

    renderWithProviders(<SkillsPage />);

    await screen.findByText('pdf');
    const toggles = screen.getAllByRole('switch');
    expect(toggles).toHaveLength(1);
    expect(toggles[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggles[0]);

    await waitFor(() => expect(saveSkillEnabledMock).toHaveBeenCalledTimes(1));
    expect(saveSkillEnabledMock).toHaveBeenCalledWith('test-token', {
      name: 'pdf',
      enabled: false,
    });
  });

  it('opens the create panel and switches between Form and ZIP modes', async () => {
    fetchSkillsMock.mockResolvedValue(makeResponse([makeSkill()]));

    renderWithProviders(<SkillsPage />);

    await screen.findByText('pdf');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(screen.getByRole('heading', { name: 'Create skill' })).toBeTruthy();
    expect(screen.queryByLabelText('Skill archive (.zip)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Upload ZIP/i }));
    expect(screen.getByLabelText('Skill archive (.zip)')).toBeTruthy();
    expect(screen.getByText('Overwrite existing skill (--force)')).toBeTruthy();
  });

  it('labels observed outcome metrics without repeating visible counts', async () => {
    fetchSkillsMock.mockResolvedValue(makeResponse([makeSkill()]));
    fetchHealthMock.mockResolvedValue({
      metrics: [makeHealthMetric()],
    });

    renderWithProviders(<SkillsPage />);

    expect(await screen.findByText('Full success')).toBeTruthy();
    expect(screen.getByText('Partial success')).toBeTruthy();
    expect(screen.getByText('Failure')).toBeTruthy();
    expect(screen.getByText('Tool breakage')).toBeTruthy();
    expect(screen.getByText('67% (2)')).toBeTruthy();
    expect(screen.getByText('33% (1)')).toBeTruthy();
    expect(screen.getByText('0% (0)')).toBeTruthy();
    expect(screen.getByText('18% (1/4)')).toBeTruthy();
    expect(screen.queryByText('1 observed skill visible')).toBeNull();
  });
});
