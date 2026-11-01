import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/toast';
import { blockerStateMock } from '../test-utils';
import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';

const { useBlockerMock } = vi.hoisted(() => ({ useBlockerMock: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useBlocker: useBlockerMock }));

beforeEach(() => {
  useBlockerMock.mockImplementation(() => blockerStateMock);
  blockerStateMock.status = 'idle';
  blockerStateMock.proceed = vi.fn();
  blockerStateMock.reset = vi.fn();
});

function Harness({
  isDirty,
  description,
  includeSearch,
}: {
  isDirty: boolean;
  description?: string;
  includeSearch?: boolean;
}) {
  const { dialog } = useUnsavedChangesGuard({
    isDirty,
    description,
    includeSearch,
  });
  return <ToastProvider>{dialog}</ToastProvider>;
}

describe('useUnsavedChangesGuard', () => {
  it('renders nothing visible while the blocker is idle', () => {
    render(<Harness isDirty={false} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('opens the alertdialog when navigation is blocked', () => {
    blockerStateMock.status = 'blocked';
    render(<Harness isDirty={true} />);
    expect(
      screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' }),
    ).toBeTruthy();
  });

  it('Keep editing calls blocker.reset and Discard and leave calls blocker.proceed', () => {
    blockerStateMock.status = 'blocked';
    render(<Harness isDirty={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(blockerStateMock.reset).toHaveBeenCalledTimes(1);
    expect(blockerStateMock.proceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(blockerStateMock.proceed).toHaveBeenCalledTimes(1);
  });

  it('honors a custom description body', () => {
    blockerStateMock.status = 'blocked';
    render(<Harness isDirty={true} description="Custom warning." />);
    expect(screen.getByText('Custom warning.')).toBeTruthy();
  });
});

it.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
])(
  'protects same-page tab drafts only when requested (dirty=%s, includeSearch=%s)',
  (isDirty, includeSearch, expected) => {
    render(<Harness isDirty={isDirty} includeSearch={includeSearch} />);
    const options = useBlockerMock.mock.calls.at(-1)?.[0] as {
      shouldBlockFn: (input: {
        current: { pathname: string; search: object };
        next: { pathname: string; search: object };
      }) => boolean;
    };
    expect(
      options.shouldBlockFn({
        current: { pathname: '/admin/security', search: { tab: 'approvals' } },
        next: { pathname: '/admin/security', search: { tab: 'safety' } },
      }),
    ).toBe(expected);
  },
);
