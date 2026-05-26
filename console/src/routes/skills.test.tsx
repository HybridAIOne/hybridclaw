import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminAdaptiveSkillAmendmentsResponse,
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
});
