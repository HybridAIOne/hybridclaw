import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetMediaCapabilitiesForTests,
  useMediaCapabilities,
} from './media-capabilities';

const fetchMediaCapabilitiesMock = vi.hoisted(() =>
  vi.fn(async (_token: string) => ({ dictation: true, readAloud: true })),
);

vi.mock('../../api/chat', () => ({
  fetchMediaCapabilities: (token: string) => fetchMediaCapabilitiesMock(token),
}));

describe('useMediaCapabilities', () => {
  beforeEach(() => {
    resetMediaCapabilitiesForTests();
    fetchMediaCapabilitiesMock.mockReset();
    fetchMediaCapabilitiesMock.mockResolvedValue({
      dictation: true,
      readAloud: true,
    });
  });

  afterEach(() => {
    resetMediaCapabilitiesForTests();
  });

  it('probes once and shares the result across mounts for one token', async () => {
    const first = renderHook(() => useMediaCapabilities('token-a'));
    await waitFor(() => {
      expect(first.result.current).toEqual({
        dictation: true,
        readAloud: true,
      });
    });

    const second = renderHook(() => useMediaCapabilities('token-a'));
    await waitFor(() => {
      expect(second.result.current).toEqual({
        dictation: true,
        readAloud: true,
      });
    });
    expect(fetchMediaCapabilitiesMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the token changes so stale capabilities do not stick', async () => {
    const { result, rerender } = renderHook(
      ({ token }: { token: string }) => useMediaCapabilities(token),
      { initialProps: { token: 'token-a' } },
    );
    await waitFor(() => {
      expect(result.current).toEqual({ dictation: true, readAloud: true });
    });

    fetchMediaCapabilitiesMock.mockResolvedValue({
      dictation: false,
      readAloud: false,
    });
    rerender({ token: 'token-b' });
    await waitFor(() => {
      expect(result.current).toEqual({ dictation: false, readAloud: false });
    });
    expect(fetchMediaCapabilitiesMock).toHaveBeenCalledTimes(2);
    expect(fetchMediaCapabilitiesMock).toHaveBeenLastCalledWith('token-b');
  });

  it('reports both capabilities unavailable when the probe fails', async () => {
    fetchMediaCapabilitiesMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useMediaCapabilities('token-a'));
    await waitFor(() => {
      expect(result.current).toEqual({ dictation: false, readAloud: false });
    });
  });
});
