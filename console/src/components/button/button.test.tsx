import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, type ButtonSize, type ButtonVariant } from './index';
import styles from './button.module.css';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button').textContent).toBe('Save');
  });

  it('defaults type to "button"', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.type).toBe('button');
  });

  it('allows type override', () => {
    render(<Button type="submit">Save</Button>);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.type).toBe('submit');
  });

  it('applies default variant and size classes', () => {
    render(<Button>Save</Button>);
    const { className } = screen.getByRole('button');
    expect(className).toContain(styles.button);
    expect(className).toContain(styles.default);
    expect(className).toContain(styles.sizeDefault);
  });

  it.each<ButtonVariant>([
    'ghost',
    'outline',
    'danger',
  ])('applies variant class for %s', (variant) => {
    render(<Button variant={variant}>Save</Button>);
    expect(screen.getByRole('button').className).toContain(styles[variant]);
  });

  it.each<[ButtonSize, keyof typeof styles]>([
    ['sm', 'sizeSm'],
    ['icon', 'sizeIcon'],
  ])('applies size class for %s', (size, styleKey) => {
    render(<Button size={size}>Save</Button>);
    expect(screen.getByRole('button').className).toContain(styles[styleKey]);
  });

  it('merges user className with base styles', () => {
    render(<Button className="custom-class">Save</Button>);
    const { className } = screen.getByRole('button');
    expect(className).toContain('custom-class');
    expect(className).toContain(styles.button);
  });

  it('forwards ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('forwards aria-label and disabled attributes', () => {
    render(
      <Button disabled aria-label="save-action">
        Save
      </Button>,
    );
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('save-action');
    expect(button.disabled).toBe(true);
  });

  it('forwards onClick handler', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
