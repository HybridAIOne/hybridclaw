import { type RefObject, useCallback, useRef, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAnimationsFinished } from './useAnimationsFinished';

// jsdom doesn't implement getAnimations — polyfill it on HTMLElement prototype
// before any tests run so the hook can safely call el.getAnimations().
if (!HTMLElement.prototype.getAnimations) {
  HTMLElement.prototype.getAnimations = () => [];
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function useHarness(
  initialExiting: boolean,
  onComplete: () => void,
  getAnimationsFn?: () => Animation[],
) {
  const ref = useRef<HTMLDivElement>(document.createElement('div'));

  // Attach the spy/stub before the hook reads it.
  if (getAnimationsFn) {
    vi.spyOn(ref.current, 'getAnimations').mockImplementation(getAnimationsFn);
  } else {
    vi.spyOn(ref.current, 'getAnimations').mockReturnValue([]);
  }

  const [exiting, setExiting] = useState(initialExiting);
  const stableOnComplete = useCallback(onComplete, [onComplete]);
  useAnimationsFinished(ref as RefObject<HTMLElement>, exiting, stableOnComplete);
  return { ref, setExiting };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAnimationsFinished', () => {
  it('does not call onComplete when exiting is false', async () => {
    const onComplete = vi.fn();

    renderHook(() => useHarness(false, onComplete));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('calls onComplete immediately when exiting=true and no animations are running', async () => {
    const onComplete = vi.fn();

    renderHook(() => useHarness(true, onComplete));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('calls onComplete after all animation finished promises resolve', async () => {
    const onComplete = vi.fn();

    let resolveA!: () => void;
    let resolveB!: () => void;
    const finishedA = new Promise<Animation>((res) => {
      resolveA = () => res({} as Animation);
    });
    const finishedB = new Promise<Animation>((res) => {
      resolveB = () => res({} as Animation);
    });

    const fakeAnimations = [
      { finished: finishedA } as unknown as Animation,
      { finished: finishedB } as unknown as Animation,
    ];

    renderHook(() => useHarness(true, onComplete, () => fakeAnimations));

    // Not yet called — animations still running.
    expect(onComplete).not.toHaveBeenCalled();

    resolveA();
    await act(async () => {
      await Promise.resolve();
    });
    // Still waiting on B.
    expect(onComplete).not.toHaveBeenCalled();

    resolveB();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve(); // flush Promise.all microtask
    });

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('calls onComplete when animations are cancelled (finished promise rejects)', async () => {
    const onComplete = vi.fn();

    let rejectA!: () => void;
    const finishedA = new Promise<Animation>((_res, rej) => {
      rejectA = () => rej(new Error('cancelled'));
    });

    const fakeAnimations = [
      { finished: finishedA } as unknown as Animation,
    ];

    renderHook(() => useHarness(true, onComplete, () => fakeAnimations));

    expect(onComplete).not.toHaveBeenCalled();

    rejectA();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('does NOT call onComplete when the component unmounts before animations finish', async () => {
    const onComplete = vi.fn();

    let resolveA!: () => void;
    const finishedA = new Promise<Animation>((res) => {
      resolveA = () => res({} as Animation);
    });
    const fakeAnimations = [{ finished: finishedA } as unknown as Animation];

    const { unmount } = renderHook(() =>
      useHarness(true, onComplete, () => fakeAnimations),
    );

    // Unmount before the animation resolves — cleanup sets cancelled=true.
    unmount();

    resolveA();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onComplete).not.toHaveBeenCalled();
  });
});
