import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusGuard } from './FocusGuard';

afterEach(cleanup);

describe('FocusGuard', () => {
  it('renders a <span> that is aria-hidden', () => {
    const { container } = render(<FocusGuard onFocus={vi.fn()} />);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('aria-hidden')).toBe('true');
  });

  it('has tabIndex={0} so it is reachable by Tab', () => {
    const { container } = render(<FocusGuard onFocus={vi.fn()} />);
    const span = container.querySelector('span');
    expect(span?.tabIndex).toBe(0);
  });

  it('calls onFocus when it receives focus', () => {
    const onFocus = vi.fn();
    const { container } = render(<FocusGuard onFocus={onFocus} />);
    const span = container.querySelector('span') as HTMLElement;
    fireEvent.focus(span);
    expect(onFocus).toHaveBeenCalledOnce();
  });
});
