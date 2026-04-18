import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import styles from './button.module.css';
import { Button, type ButtonSize, type ButtonVariant } from './index';

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

  it('blocks onClick when disabled (aria-disabled path)', () => {
    const onClick = vi.fn();
    const anchor = <a href="/x">placeholder</a>;
    render(
      <Button render={anchor} disabled onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(onClick).not.toHaveBeenCalled();
  });

  describe('loading', () => {
    it('sets aria-busy and aria-disabled but not native disabled', () => {
      render(<Button loading>Save</Button>);
      const button = screen.getByRole('button') as HTMLButtonElement;
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.disabled).toBe(false);
    });

    it('keeps the button focusable while loading', () => {
      render(<Button loading>Save</Button>);
      const button = screen.getByRole('button');
      button.focus();
      expect(document.activeElement).toBe(button);
    });

    it('suppresses onClick while loading', () => {
      const onClick = vi.fn();
      render(
        <Button loading onClick={onClick}>
          Save
        </Button>,
      );
      fireEvent.click(screen.getByRole('button'));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('exposes data-loading and data-disabled attributes', () => {
      render(<Button loading>Save</Button>);
      const button = screen.getByRole('button');
      expect(button.hasAttribute('data-loading')).toBe(true);
      expect(button.hasAttribute('data-disabled')).toBe(true);
    });
  });

  describe('render prop', () => {
    it('renders as the provided element', () => {
      const anchor = <a href="/docs">placeholder</a>;
      render(<Button render={anchor}>Docs</Button>);
      const link = screen.getByRole('link');
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('/docs');
      expect(link.textContent).toBe('Docs');
    });

    it('applies Button styles to the rendered element', () => {
      const anchor = <a href="/x">placeholder</a>;
      render(<Button render={anchor}>Go</Button>);
      expect(screen.getByRole('link').className).toContain(styles.button);
    });

    it('merges className from the render element with Button styles', () => {
      const anchor = (
        <a href="/x" className="link-extra">
          placeholder
        </a>
      );
      render(<Button render={anchor}>Go</Button>);
      const { className } = screen.getByRole('link');
      expect(className).toContain(styles.button);
      expect(className).toContain('link-extra');
    });

    it('preserves the render element children when Button has none', () => {
      render(<Button render={<a href="/x">Fallback</a>} />);
      expect(screen.getByRole('link').textContent).toBe('Fallback');
    });
  });
});
