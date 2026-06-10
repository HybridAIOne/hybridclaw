import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { DistillPage } from './distill';

const fetchDistillMock = vi.fn();
const recordDistillConsentMock = vi.fn();
const registerDistillAgentMock = vi.fn();
const runDistillMock = vi.fn();
const saveDistillSubjectMock = vi.fn();
const uploadDistillSourceMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchDistill: (...args: unknown[]) => fetchDistillMock(...args),
  recordDistillConsent: (...args: unknown[]) =>
    recordDistillConsentMock(...args),
  registerDistillAgent: (...args: unknown[]) =>
    registerDistillAgentMock(...args),
  runDistill: (...args: unknown[]) => runDistillMock(...args),
  saveDistillSubject: (...args: unknown[]) => saveDistillSubjectMock(...args),
  uploadDistillSource: (...args: unknown[]) => uploadDistillSourceMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeSubject() {
  return {
    agentId: 'maya',
    alias: 'maya',
    registeredAgent: true,
    profile: {
      version: 1 as const,
      alias: 'maya',
      displayName: 'Maya Lindqvist',
      realPerson: true,
      role: 'Architect',
      relationship: '',
      personalityTags: [],
      matchAliases: ['Maya Lindqvist', 'maya@example.com'],
      createdAt: '2026-06-10T10:00:00.000Z',
    },
    consent: {
      present: true,
      valid: true,
      revokedAt: null,
      recordedAt: '2026-06-10T10:01:00.000Z',
      grantedBy: 'Maya Lindqvist',
      method: 'written',
      scope: 'Distill persona and working knowledge.',
      sha256: 'abc',
    },
    corpusDocuments: 2,
    openReviews: 0,
    runs: [],
    latestRun: null,
  };
}

describe('DistillPage', () => {
  beforeEach(() => {
    fetchDistillMock.mockReset();
    recordDistillConsentMock.mockReset();
    registerDistillAgentMock.mockReset();
    runDistillMock.mockReset();
    saveDistillSubjectMock.mockReset();
    uploadDistillSourceMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchDistillMock.mockResolvedValue({
      sourceKinds: ['auto', 'markdown', 'text'],
      subjects: [makeSubject()],
    });
    registerDistillAgentMock.mockResolvedValue({
      subject: makeSubject(),
    });
    runDistillMock.mockResolvedValue({
      subject: makeSubject(),
      run: {
        runId: 'dst_1',
        status: 'awaiting-extraction',
        createdAt: '2026-06-10T10:02:00.000Z',
        updatedAt: '2026-06-10T10:02:00.000Z',
        stages: {
          ingest: { status: 'completed' },
          analyse: { status: 'completed' },
          build: { status: 'awaiting-extraction' },
          merge: { status: 'pending' },
          correct: { status: 'pending' },
        },
        stats: {
          documentsAdded: 1,
          documentsTotal: 3,
          deltaDocuments: 1,
          claimsAdded: 0,
          claimsFlagged: 0,
          reviewsOpened: 0,
        },
        sources: [],
        reportPath: '/tmp/REPORT.md',
        packetMarkdownPath: '/tmp/PACKET.md',
        extractionPath: '/tmp/extraction.json',
      },
      warnings: [],
      flagged: [],
    });
  });

  it('starts a run with manually entered source paths', async () => {
    renderWithProviders(<DistillPage />);

    await screen.findByText('Maya Lindqvist');
    fireEvent.change(screen.getByLabelText('Host paths'), {
      target: { value: '/sources/memo.md' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Distill' }));

    await waitFor(() => {
      expect(runDistillMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          alias: 'maya',
          sources: [{ path: '/sources/memo.md', kind: 'auto' }],
        }),
      );
    });
  });

  it('registers a distill subject as a switchable agent', async () => {
    fetchDistillMock.mockResolvedValue({
      sourceKinds: ['auto', 'markdown', 'text'],
      subjects: [{ ...makeSubject(), registeredAgent: false }],
    });
    renderWithProviders(<DistillPage />);

    await screen.findByText(/unregistered/);
    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Register Agent' });
      if (button.hasAttribute('disabled')) {
        throw new Error('Register button is disabled.');
      }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register Agent' }));

    await waitFor(() => {
      expect(registerDistillAgentMock).toHaveBeenCalledWith('test-token', {
        agentId: 'maya',
        alias: 'maya',
      });
    });
  });
});
