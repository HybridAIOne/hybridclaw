import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAuditEntry, AdminAuditResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { AuditPage } from './audit';

type FetchAuditParams = {
  query?: string;
  sessionId?: string;
  eventType?: string;
  limit?: number;
};
const fetchAuditMock =
  vi.fn<(token: string, params: FetchAuditParams) => Promise<AdminAuditResponse>>();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAudit: (token: string, params: FetchAuditParams) =>
    fetchAuditMock(token, params),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => {
    const params = new URLSearchParams(window.location.search);
    return {
      q: params.get('q') ?? undefined,
      range: params.get('range') ?? undefined,
    };
  },
}));

function makeEntry(overrides: Partial<AdminAuditEntry> = {}): AdminAuditEntry {
  return {
    id: 1,
    sessionId: 'web:default',
    seq: 1,
    eventType: 'session.start',
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    runId: 'run_abc',
    parentRunId: null,
    payload: '{"foo":"bar"}',
    createdAt: '2026-05-23T12:00:00.000Z',
    ...overrides,
  };
}

function makeResponse(entries: AdminAuditEntry[]): AdminAuditResponse {
  return {
    query: '',
    sessionId: '',
    eventType: '',
    limit: 200,
    entries,
  };
}

describe('AuditPage', () => {
  beforeEach(() => {
    fetchAuditMock.mockReset();
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    window.history.replaceState(null, '', '/admin/audit');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders entries returned by the API', async () => {
    fetchAuditMock.mockResolvedValue(
      makeResponse([
        makeEntry({ id: 100, eventType: 'tool.call', sessionId: 'web:a' }),
        makeEntry({ id: 101, eventType: 'tool.result', sessionId: 'web:a' }),
      ]),
    );
    renderWithProviders(<AuditPage />);
    expect(await screen.findByText('#100')).toBeTruthy();
    expect(screen.getByText('#101')).toBeTruthy();
    expect(screen.getByText('2 events')).toBeTruthy();
  });

  it('shows an empty state when no entries match', async () => {
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    expect(
      await screen.findByText('No audit entries match these filters.'),
    ).toBeTruthy();
  });

  it('shows a loading message while the query is in flight', async () => {
    fetchAuditMock.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<AuditPage />);
    expect(await screen.findByText('Loading audit entries…')).toBeTruthy();
  });

  it('seeds filters from the URL on mount', async () => {
    window.history.replaceState(null, '', '/admin/audit?q=type%3Atool&range=24h');
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    const input = await screen.findByLabelText<HTMLInputElement>(
      'Audit search',
    );
    expect(input.value).toBe('type:tool');
    expect(
      screen.getByRole('button', { name: '24h', pressed: true }),
    ).toBeTruthy();
  });

  it('calls fetchAudit with parsed tokens from the search input', async () => {
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    const input = await screen.findByLabelText('Audit search');
    fireEvent.change(input, {
      target: { value: 'session:web type:tool error' },
    });
    await waitFor(() => {
      expect(fetchAuditMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          query: 'error',
          sessionId: 'web',
          eventType: 'tool',
          limit: 200,
        }),
      );
    });
  });

  it('writes the search input to the URL via navigate', async () => {
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    const input = await screen.findByLabelText('Audit search');
    fireEvent.change(input, { target: { value: 'type:tool' } });
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '/admin/audit',
          search: { q: 'type:tool', range: undefined },
          replace: true,
        }),
      );
    });
  });

  it('filters client-side by time range and updates the URL', async () => {
    const now = Date.now();
    fetchAuditMock.mockResolvedValue(
      makeResponse([
        makeEntry({
          id: 1,
          timestamp: new Date(now - 30 * 60_000).toISOString(),
        }),
        makeEntry({
          id: 2,
          timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
        }),
      ]),
    );
    renderWithProviders(<AuditPage />);
    expect(await screen.findByText('2 events')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => {
      expect(screen.getByText('1 event')).toBeTruthy();
    });
    expect(navigateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: { q: undefined, range: '1h' },
      }),
    );
  });

  it('category chip click writes a type: token into the search', async () => {
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'tool' }));
    const input = screen.getByLabelText<HTMLInputElement>('Audit search');
    await waitFor(() => {
      expect(input.value).toBe('type:tool');
    });
    expect(
      screen.getByRole('button', { name: 'tool', pressed: true }),
    ).toBeTruthy();
  });

  it('clicking the active category chip clears the type filter', async () => {
    window.history.replaceState(null, '', '/admin/audit?q=type%3Atool');
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'tool', pressed: true }),
    );
    await waitFor(() => {
      const input = screen.getByLabelText<HTMLInputElement>('Audit search');
      expect(input.value).toBe('');
    });
  });

  it('row click opens the inspector drawer', async () => {
    fetchAuditMock.mockResolvedValue(
      makeResponse([
        makeEntry({ id: 42, eventType: 'tool.result', payload: '{"ok":true}' }),
      ]),
    );
    renderWithProviders(<AuditPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Inspect audit event 42/ }),
    );
    expect(await screen.findByText(/"ok": true/)).toBeTruthy();
  });

  it('drawer body survives a filter change that refetches different entries', async () => {
    fetchAuditMock.mockResolvedValueOnce(
      makeResponse([
        makeEntry({ id: 42, eventType: 'tool.result', payload: '{"a":1}' }),
      ]),
    );
    renderWithProviders(<AuditPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Inspect audit event 42/ }),
    );
    expect(await screen.findByText(/"a": 1/)).toBeTruthy();

    fetchAuditMock.mockResolvedValue(
      makeResponse([
        makeEntry({ id: 99, eventType: 'session.start', payload: '{"b":2}' }),
      ]),
    );
    fireEvent.change(screen.getByLabelText('Audit search'), {
      target: { value: 'type:session' },
    });
    await waitFor(() => {
      expect(screen.getByText('#99')).toBeTruthy();
    });
    // Drawer still shows event 42's payload, not blank.
    expect(screen.getByText(/"a": 1/)).toBeTruthy();
  });

  it('active-filter chip × strips that token from the search', async () => {
    window.history.replaceState(
      null,
      '',
      '/admin/audit?q=session%3Aweb+type%3Atool',
    );
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Remove session filter web/ }),
    );
    await waitFor(() => {
      const input = screen.getByLabelText<HTMLInputElement>('Audit search');
      expect(input.value).toBe('type:tool');
    });
  });

  it('Clear all resets search and time range', async () => {
    window.history.replaceState(
      null,
      '',
      '/admin/audit?q=type%3Atool&range=24h',
    );
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    await waitFor(() => {
      const input = screen.getByLabelText<HTMLInputElement>('Audit search');
      expect(input.value).toBe('');
    });
    expect(
      screen.getByRole('button', { name: 'All', pressed: true }),
    ).toBeTruthy();
  });

  it('"/" focuses the search input from outside an input', async () => {
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    const input = await screen.findByLabelText<HTMLInputElement>(
      'Audit search',
    );
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('"/" is ignored when typed inside an input', async () => {
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    const input = await screen.findByLabelText<HTMLInputElement>(
      'Audit search',
    );
    // Focus another input-like element so the shortcut would normally fire.
    // Use a separate input we add ad-hoc.
    const probe = document.createElement('input');
    document.body.appendChild(probe);
    probe.focus();
    fireEvent.keyDown(probe, { key: '/' });
    expect(document.activeElement).toBe(probe);
    expect(document.activeElement).not.toBe(input);
    probe.remove();
  });

  it('skips redundant navigate() when state already matches the URL on mount', async () => {
    window.history.replaceState(null, '', '/admin/audit?q=type%3Atool');
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    await screen.findByDisplayValue('type:tool');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('aria-pressed reflects the active category and time range', async () => {
    window.history.replaceState(
      null,
      '',
      '/admin/audit?q=type%3Atool&range=7d',
    );
    fetchAuditMock.mockResolvedValue(makeResponse([]));
    renderWithProviders(<AuditPage />);
    expect(
      await screen.findByRole('button', { name: 'tool', pressed: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'session', pressed: false }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'all', pressed: false }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '7d', pressed: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'All', pressed: false }),
    ).toBeTruthy();
  });
});
