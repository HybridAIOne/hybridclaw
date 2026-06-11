import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { DistillPage } from './distill';

const deleteDistillCorpusDocumentMock = vi.fn();
const downloadDistillCorpusDocumentMock = vi.fn();
const fetchDistillMock = vi.fn();
const recordDistillConsentMock = vi.fn();
const registerDistillAgentMock = vi.fn();
const runDistillMock = vi.fn();
const saveDistillSubjectMock = vi.fn();
const uploadDistillSourceMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  deleteDistillCorpusDocument: (...args: unknown[]) =>
    deleteDistillCorpusDocumentMock(...args),
  downloadDistillCorpusDocument: (...args: unknown[]) =>
    downloadDistillCorpusDocumentMock(...args),
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

function embeddedText(content: string) {
  return {
    available: true,
    content,
    byteLength: content.length,
    truncated: false,
    error: null,
  };
}

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
    paths: {
      workspacePath: '/tmp/hybridclaw/agents/maya/workspace',
      subjectPath: '/tmp/hybridclaw/agents/maya/workspace/distill/maya',
      uploadsPath: '/tmp/hybridclaw/agents/maya/workspace/distill/maya/uploads',
      corpusDocumentsPath:
        '/tmp/hybridclaw/agents/maya/workspace/distill/maya/corpus/documents.jsonl',
    },
    corpusDocuments: 2,
    corpus: [
      {
        id: 'doc_abc123abc123',
        source: 'markdown' as const,
        origin:
          '/tmp/hybridclaw/agents/maya/workspace/distill/maya/uploads/2026-06-10/memo.md',
        author: 'Maya Lindqvist',
        authoredBySubject: true,
        wordCount: 42,
        weight: 0.8,
        holdout: false,
        runId: 'dst_1',
        contentPreview: embeddedText('# Memo\n\nBoring options win.'),
      },
    ],
    openReviews: 0,
    runs: [],
    latestRun: null,
  };
}

describe('DistillPage', () => {
  beforeEach(() => {
    deleteDistillCorpusDocumentMock.mockReset();
    downloadDistillCorpusDocumentMock.mockReset();
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
    saveDistillSubjectMock.mockResolvedValue({
      subject: {
        ...makeSubject(),
        agentId: 'nora',
        alias: 'nora',
        profile: {
          ...makeSubject().profile,
          alias: 'nora',
          displayName: 'Nora Hart',
        },
      },
    });
    deleteDistillCorpusDocumentMock.mockResolvedValue({
      subject: { ...makeSubject(), corpusDocuments: 0, corpus: [] },
    });
    downloadDistillCorpusDocumentMock.mockResolvedValue(
      new Blob(['# Memo\n\nBoring options win.'], { type: 'text/plain' }),
    );
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
        artifacts: {
          report: embeddedText('# Report\n\nAwaiting extraction.'),
          packetMarkdown: embeddedText('# Packet\n\nRead this.'),
          extraction: {
            available: false,
            content: '',
            byteLength: 0,
            truncated: false,
            error: 'Not generated yet.',
          },
        },
      },
      warnings: [],
      flagged: [],
    });
  });

  it('starts a run with manually entered source paths', async () => {
    renderWithProviders(<DistillPage />);

    await screen.findByText('Maya Lindqvist');
    expect(screen.getByText(/Reserves part of the corpus/)).toBeTruthy();
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

  it('starts a blank subject draft from an existing subject', async () => {
    renderWithProviders(<DistillPage />);

    await screen.findByText('Maya Lindqvist');
    fireEvent.click(screen.getByRole('button', { name: 'New Subject' }));

    await waitFor(() => {
      const alias = screen.getByLabelText('Alias') as HTMLInputElement;
      expect(alias.value).toBe('');
    });
    fireEvent.change(screen.getByLabelText('Alias'), {
      target: { value: 'nora' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Nora Hart' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Subject' }));

    await waitFor(() => {
      expect(saveDistillSubjectMock).toHaveBeenCalledWith('test-token', {
        agentId: undefined,
        alias: 'nora',
        displayName: 'Nora Hart',
        role: undefined,
        relationship: undefined,
        realPerson: true,
        personalityTags: [],
        matchAliases: [],
      });
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
      const alias = screen.getByLabelText('Alias') as HTMLInputElement;
      expect(alias.value).toBe('maya');
    });
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

  it('shows source data paths and ingested corpus documents', async () => {
    const run = {
      runId: 'dst_1',
      status: 'completed' as const,
      createdAt: '2026-06-10T10:02:00.000Z',
      updatedAt: '2026-06-10T10:03:00.000Z',
      stages: {
        ingest: { status: 'completed' as const },
        analyse: { status: 'completed' as const },
        build: { status: 'completed' as const },
        merge: { status: 'completed' as const },
        correct: { status: 'completed' as const },
      },
      stats: {
        documentsAdded: 1,
        documentsTotal: 2,
        deltaDocuments: 1,
        claimsAdded: 1,
        claimsFlagged: 0,
        reviewsOpened: 0,
      },
      sources: [
        {
          path: '/tmp/hybridclaw/agents/maya/workspace/distill/maya/uploads/2026-06-10/memo.md',
          kind: 'markdown' as const,
        },
      ],
      reportPath:
        '/tmp/hybridclaw/agents/maya/workspace/runtime/distill/dst_1/REPORT.md',
      packetMarkdownPath:
        '/tmp/hybridclaw/agents/maya/workspace/runtime/distill/dst_1/analysis/PACKET.md',
      extractionPath:
        '/tmp/hybridclaw/agents/maya/workspace/runtime/distill/dst_1/analysis/extraction.json',
      artifacts: {
        report: embeddedText('# Distill Report\n\nReport for cloud users.'),
        packetMarkdown: embeddedText('# Packet\n\nPacket for cloud users.'),
        extraction: embeddedText('{"version":1}'),
      },
    };
    fetchDistillMock.mockResolvedValue({
      sourceKinds: ['auto', 'markdown', 'text'],
      subjects: [{ ...makeSubject(), runs: [run], latestRun: run }],
    });
    renderWithProviders(<DistillPage />);

    await screen.findByText('Source Data');
    expect(screen.getByText(/Server paths are provenance only/)).toBeTruthy();
    expect(screen.getByText('memo.md')).toBeTruthy();
    expect(
      screen.getByText(
        '/tmp/hybridclaw/agents/maya/workspace/distill/maya/uploads',
      ),
    ).toBeTruthy();
    expect(screen.getByText('doc_abc123abc123')).toBeTruthy();
    expect(screen.getByText(/Report for cloud users/)).toBeTruthy();
    expect(screen.getByText(/Boring options win/)).toBeTruthy();
    expect(
      screen.getAllByText(
        '/tmp/hybridclaw/agents/maya/workspace/distill/maya/uploads/2026-06-10/memo.md',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('downloads and deletes corpus documents', async () => {
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    }
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:distill-document');
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithProviders(<DistillPage />);

    await screen.findByText('Maya Lindqvist');
    fireEvent.click(
      screen.getByRole('button', { name: 'Download doc_abc123abc123' }),
    );

    await waitFor(() => {
      expect(downloadDistillCorpusDocumentMock).toHaveBeenCalledWith(
        'test-token',
        {
          agentId: 'maya',
          alias: 'maya',
          documentId: 'doc_abc123abc123',
        },
      );
    });
    await waitFor(() => {
      expect(createObjectUrl).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete doc_abc123abc123' }),
    );

    await waitFor(() => {
      expect(deleteDistillCorpusDocumentMock).toHaveBeenCalledWith(
        'test-token',
        {
          agentId: 'maya',
          alias: 'maya',
          documentId: 'doc_abc123abc123',
        },
      );
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Delete doc_abc123abc123'),
    );

    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
    click.mockRestore();
    confirm.mockRestore();
  });
});
