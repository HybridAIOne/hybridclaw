import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Label } from './index';

describe('Label', () => {
  it('renders a <label> element with data-slot', () => {
    render(<Label>Email</Label>);
    const label = screen.getByText('Email');
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('data-slot')).toBe('label');
  });

  it('passes htmlFor through to the underlying label', () => {
    render(<Label htmlFor="email-input">Email</Label>);
    expect(screen.getByText('Email').getAttribute('for')).toBe('email-input');
  });

  it('merges caller className with the base style', () => {
    render(<Label className="custom">Email</Label>);
    expect(screen.getByText('Email').className).toContain('custom');
  });

  it('forwards arbitrary props onto the <label>', () => {
    render(
      <Label data-testid="lbl" title="tooltip">
        Email
      </Label>,
    );
    expect(screen.getByTestId('lbl').getAttribute('title')).toBe('tooltip');
  });
});
