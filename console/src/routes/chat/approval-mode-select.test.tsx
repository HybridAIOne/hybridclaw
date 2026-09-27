import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalModeSelect } from './approval-mode-select';

describe('ApprovalModeSelect', () => {
  it('shows the current mode and reports a new choice', () => {
    const onChange = vi.fn();
    render(<ApprovalModeSelect value="auto" onChange={onChange} />);

    const trigger = screen.getByRole('combobox', { name: 'Approvals: Auto' });
    fireEvent.click(trigger);
    expect(
      screen
        .getByRole('option', { name: 'Auto' })
        .getAttribute('aria-selected'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: 'Full access' }));
    expect(onChange).toHaveBeenCalledWith('full');
  });

  it('does not report reselecting the current mode', () => {
    const onChange = vi.fn();
    render(<ApprovalModeSelect value="ask" onChange={onChange} />);

    fireEvent.click(
      screen.getByRole('combobox', { name: 'Approvals: Ask first' }),
    );
    fireEvent.click(screen.getByRole('option', { name: 'Ask first' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks full access on the trigger so it renders as a warning', () => {
    render(<ApprovalModeSelect value="full" onChange={vi.fn()} />);
    expect(
      screen
        .getByRole('combobox', { name: 'Approvals: Full access' })
        .getAttribute('data-mode'),
    ).toBe('full');
  });
});
