/** Presence reports keep the owner's phone quiet only while this page is in use. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useComputerPresence } from './use-computer-presence';

vi.mock('../../api/client', () => ({ requestHeaders: () => ({}) }));

const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit) => new Response('{}'),
);
let visible = true;
const reports = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).active);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('reports while visible and in use, and stops when hidden, idle or closed', () => {
  const { unmount } = renderHook(() => useComputerPresence('token', true));
  expect(reports()).toEqual([true]);
  act(() => vi.advanceTimersByTime(30_000));
  expect(reports()).toEqual([true, true]);

  visible = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => vi.advanceTimersByTime(60_000));
  expect(reports()).toEqual([true, true, false]);

  visible = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => vi.advanceTimersByTime(5 * 60_000));
  // Five minutes without a key or pointer: away.
  expect(reports().at(-1)).toBe(false);
  act(() => window.dispatchEvent(new Event('keydown')));
  expect(reports().at(-1)).toBe(true);

  unmount();
  expect(reports().at(-1)).toBe(false);
});

test('a hidden page says nothing, and nothing is sent while chat is unavailable', () => {
  visible = false;
  renderHook(() => useComputerPresence('token', true));
  renderHook(() => useComputerPresence('token', false));
  act(() => vi.advanceTimersByTime(60_000));
  expect(fetchMock).not.toHaveBeenCalled();
});
