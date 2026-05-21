import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/toast';
import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';

const blockerStateMock: {
  status: 'idle' | 'blocked';
  proceed: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} = {
  status: 'idle',
  proceed: vi.fn(),
  reset: vi.fn(),
};

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => blockerStateMock,
}));

beforeEach(() => {
  blockerStateMock.status = 'idle';
  blockerStateMock.proceed = vi.fn();
  blockerStateMock.reset = vi.fn();
});

function Harness({
  isDirty,
  description,
}: {
  isDirty: boolean;
  description?: string;
}) {
  const { dialog } = useUnsavedChangesGuard({ isDirty, description });
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
