import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFormMutation } from './use-form-mutation';

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }
  return { Wrapper, invalidateSpy };
}

describe('useFormMutation', () => {
  it('runs onSuccess and invalidates sibling queries after a successful save', async () => {
    const { Wrapper, invalidateSpy } = wrapper();
    const onSuccess = vi.fn();
    const mutationFn = vi.fn(async (input: { value: number }) => ({
      saved: input.value,
    }));

    const { result } = renderHook(
      () =>
        useFormMutation({
          mutationFn,
          onSuccess,
          invalidates: [['overview'], ['dashboard']],
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ value: 42 });
    });

    expect(onSuccess).toHaveBeenCalledWith({ saved: 42 }, { value: 42 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['overview'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboard'] });
  });

  it('runs onError with a normalised Error when the mutation rejects', async () => {
    const { Wrapper } = wrapper();
    const onError = vi.fn();
    const mutationFn = vi.fn(async () => {
      throw 'boom';
    });

    const { result } = renderHook(
      () => useFormMutation({ mutationFn, onError }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.mutate({});
    });

    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [error, input] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('boom');
    expect(input).toEqual({});
  });
});
