import {
  createContext,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import css from './index.module.css';

interface ScrollState {
  thumbSize: number;
  thumbOffset: number;
  visible: boolean;
}

type ScrollAreaContextValue = {
  viewportRef: Ref<HTMLDivElement | null>;
  setViewportEl: (el: HTMLDivElement | null) => void;
  scrollState: ScrollState;
  registerScrollbarTrack: (el: HTMLDivElement | null) => void;
};

const ScrollAreaContext = createContext<ScrollAreaContextValue | null>(null);

function useScrollAreaContext(name: string): ScrollAreaContextValue {
  const ctx = useContext(ScrollAreaContext);
  if (!ctx) throw new Error(`${name} must be used within <ScrollArea>`);
  return ctx;
}

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function ScrollArea({ className, children, ...rest }: ScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackElRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState<ScrollState>({
    thumbSize: 0,
    thumbOffset: 0,
    visible: false,
  });

  const recompute = useCallback(() => {
    const vp = viewportRef.current;
    const track = trackElRef.current;
    if (!vp || !track) {
      setScrollState((prev) =>
        prev.visible ? { ...prev, visible: false } : prev,
      );
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = vp;
    if (scrollHeight <= clientHeight + 1) {
      setScrollState((prev) =>
        prev.visible ? { ...prev, visible: false } : prev,
      );
      return;
    }
    const trackHeight = track.clientHeight;
    if (trackHeight <= 0) return;
    const ratio = clientHeight / scrollHeight;
    const thumbSize = Math.max(20, trackHeight * ratio);
    const maxScroll = scrollHeight - clientHeight;
    const maxThumbOffset = trackHeight - thumbSize;
    const thumbOffset =
      maxScroll <= 0 ? 0 : (scrollTop / maxScroll) * maxThumbOffset;
    setScrollState((prev) =>
      prev.visible &&
      prev.thumbSize === thumbSize &&
      prev.thumbOffset === thumbOffset
        ? prev
        : { thumbSize, thumbOffset, visible: true },
    );
  }, []);

  const setViewportEl = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      requestAnimationFrame(recompute);
    },
    [recompute],
  );

  const registerScrollbarTrack = useCallback(
    (el: HTMLDivElement | null) => {
      trackElRef.current = el;
      requestAnimationFrame(recompute);
    },
    [recompute],
  );

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    recompute();

    let frame = 0;
    const handleScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    vp.addEventListener('scroll', handleScroll, { passive: true });

    const ro = new ResizeObserver(() => recompute());
    ro.observe(vp);
    if (vp.firstElementChild) ro.observe(vp.firstElementChild);
    if (trackElRef.current) ro.observe(trackElRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      vp.removeEventListener('scroll', handleScroll);
      ro.disconnect();
    };
  }, [recompute]);

  const ctx: ScrollAreaContextValue = {
    viewportRef,
    setViewportEl,
    scrollState,
    registerScrollbarTrack,
  };

  return (
    <ScrollAreaContext.Provider value={ctx}>
      <div className={cx(css.root, className)} {...rest}>
        {children}
      </div>
    </ScrollAreaContext.Provider>
  );
}

interface ScrollAreaViewportProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
}

export function ScrollAreaViewport({
  className,
  children,
  ref,
  ...rest
}: ScrollAreaViewportProps) {
  const ctx = useScrollAreaContext('ScrollAreaViewport');
  return (
    <div
      ref={(el) => {
        ctx.setViewportEl(el);
        if (typeof ref === 'function') ref(el);
        else if (ref && typeof ref === 'object') {
          (ref as { current: HTMLDivElement | null }).current = el;
        }
      }}
      className={cx(css.viewport, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

interface ScrollAreaScrollbarProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'vertical';
}

export function ScrollAreaScrollbar({
  className,
  children,
  ...rest
}: ScrollAreaScrollbarProps) {
  const ctx = useScrollAreaContext('ScrollAreaScrollbar');
  return (
    <div
      ref={ctx.registerScrollbarTrack}
      data-orientation="vertical"
      data-state={ctx.scrollState.visible ? 'visible' : 'hidden'}
      aria-hidden="true"
      className={cx(css.scrollbar, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ScrollAreaThumb({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  const ctx = useScrollAreaContext('ScrollAreaThumb');
  const { thumbSize, thumbOffset } = ctx.scrollState;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const vp = (ctx.viewportRef as { current: HTMLDivElement | null }).current;
    const track = (event.currentTarget.parentElement as HTMLDivElement) ?? null;
    if (!vp || !track) return;

    const startY = event.clientY;
    const startScrollTop = vp.scrollTop;
    const trackHeight = track.clientHeight;
    const scrollRange = vp.scrollHeight - vp.clientHeight;
    const trackRange = Math.max(1, trackHeight - thumbSize);

    const handleMove = (e: PointerEvent) => {
      const delta = e.clientY - startY;
      const scrollDelta = (delta / trackRange) * scrollRange;
      vp.scrollTop = startScrollTop + scrollDelta;
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  return (
    <div
      className={cx(css.thumb, className)}
      style={{
        height: thumbSize,
        transform: `translateY(${thumbOffset}px)`,
      }}
      onPointerDown={handlePointerDown}
      {...rest}
    />
  );
}
