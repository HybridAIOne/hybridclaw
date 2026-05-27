import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminAdaptiveSkillAmendmentsResponse,
  AdminAdaptiveSkillHealthMetric,
  AdminAdaptiveSkillHealthResponse,
  AdminSkill,
  AdminSkillsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { SkillsPage } from './skills';

const fetchSkillsMock = vi.fn<() => Promise<AdminSkillsResponse>>();
const fetchHealthMock =
  vi.fn<() => Promise<AdminAdaptiveSkillHealthResponse>>();
const fetchAmendmentsMock =
  vi.fn<() => Promise<AdminAdaptiveSkillAmendmentsResponse>>();
const saveSkillEnabledMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchSkills: () => fetchSkillsMock(),
  fetchAdaptiveSkillHealth: () => fetchHealthMock(),
  fetchAdaptiveSkillAmendments: () => fetchAmendmentsMock(),
  fetchAdaptiveSkillAmendmentHistory: () => fetchAmendmentsMock(),
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
    source: 'bundled',
    available: true,
    enabled: true,
    missing: [],
    userInvocable: true,
    disableModelInvocation: false,
    always: false,
    tags: [],
    relatedSkills: [],
    ...overrides,
  };
}

function makeResponse(skills: AdminSkill[]): AdminSkillsResponse {
  return { extraDirs: [], disabled: [], skills };
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
    saveSkillEnabledMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchHealthMock.mockResolvedValue({ metrics: [] });
    fetchAmendmentsMock.mockResolvedValue({ amendments: [] });
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
