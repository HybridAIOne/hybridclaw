import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type RenderOptions,
  type RenderResult,
  render,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { ToastProvider } from '../components/toast';

/**
 * QueryClient configured for tests: no retries on queries or mutations.
 * Each test typically wants a fresh instance so cache state doesn't bleed
 * between cases.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export type RenderWithProvidersOptions = {
  queryClient?: QueryClient;
  withToast?: boolean;
  /**
   * Wrap the rendered tree in additional providers. Useful for ad-hoc
   * context (auth, theme, …) without bloating the default helper.
   */
  wrap?: (children: ReactNode) => ReactElement;
} & Omit<RenderOptions, 'wrapper'>;

export type RenderWithProvidersResult = RenderResult & {
  queryClient: QueryClient;
};

/**
 * Drop-in replacement for testing-library's `render` that wraps the tree in
 * the standard admin-page providers (TanStack Query, Toast). Pages that
 * also need router context should mock `@tanstack/react-router` separately
 * (see `mockRouterBlocker` below).
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const { withToast = true, wrap, ...renderOptions } = options;

  const Wrapper = ({ children }: { children: ReactNode }) => {
    const wrapped = wrap ? wrap(children) : children;
    const withToastTree = withToast ? (
      <ToastProvider>{wrapped}</ToastProvider>
    ) : (
      wrapped
    );
    return (
      <QueryClientProvider client={queryClient}>
        {withToastTree}
      </QueryClientProvider>
    );
  };

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
    queryClient,
  };
}

/**
 * Stateful mock for `useBlocker` from `@tanstack/react-router`. Tests that
 * verify navigation-blocking behavior should call `setBlockerStatus` to
 * flip into the 'blocked' state and assert on the proceed / reset spies.
 *
 *   import { vi } from 'vitest';
 *   import { blockerStateMock, mockRouterBlocker } from '.../test-utils';
 *   vi.mock('@tanstack/react-router', () => mockRouterBlocker());
 *
 *   beforeEach(() => {
 *     blockerStateMock.status = 'idle';
 *     blockerStateMock.proceed = vi.fn();
 *     blockerStateMock.reset = vi.fn();
 *   });
 */
export type BlockerStateMock = {
  status: 'idle' | 'blocked';
  proceed: () => void;
  reset: () => void;
};

export const blockerStateMock: BlockerStateMock = {
  status: 'idle',
  proceed: () => {},
  reset: () => {},
};

export function mockRouterBlocker() {
  return {
    useBlocker: () => blockerStateMock,
    Link: ({
      to,
      children,
      ...rest
    }: { to: string; children: ReactNode } & Record<string, unknown>) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
}
