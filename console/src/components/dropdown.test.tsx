import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from './dropdown/index';

async function flushTimers() {
  await act(async () => {
    vi.runAllTimers();
  });
}

describe('Dropdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders trigger button', () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    expect(screen.getByRole('button')).toBeDefined();
    expect(screen.getByRole('button').textContent).toBe('Open');
  });

  it('opens dropdown when trigger is clicked', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();
  });

  it('closes dropdown when item is clicked', async () => {
    const handleSelect = vi.fn();

    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem onSelect={handleSelect}>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();

    const item = screen.getByRole('button', { name: 'Item 1' });
    fireEvent.click(item);

    expect(handleSelect).toHaveBeenCalled();

    await flushTimers();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes dropdown when clicking outside', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();

    fireEvent.mouseDown(document.body);
    await flushTimers();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes dropdown on escape key', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape' });
    await flushTimers();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('applies custom className to trigger', () => {
    render(
      <Dropdown>
        <DropdownTrigger className="custom-trigger">Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const button = screen.getByRole('button');
    expect(button.className).toContain('custom-trigger');
  });

  it('applies custom className to content when open', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent className="custom-content">
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    expect(screen.getByText('Item 1').parentElement?.className).toContain(
      'custom-content',
    );
  });

  it('applies custom className to items', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem className="custom-item">Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    const item = screen.getByRole('button', { name: 'Item 1' });
    expect(item.className).toContain('custom-item');
  });

  it('opens on arrow down key', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();
  });

  it('opens on enter key', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();
  });

  it('opens on space key', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: ' ' });
    await flushTimers();

    expect(screen.getByText('Item 1')).toBeDefined();
  });

  it('has correct aria attributes on trigger', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    expect(trigger.getAttribute('aria-controls')).toBeTruthy();
    expect(trigger.getAttribute('data-state')).toBe('closed');

    fireEvent.click(trigger);
    await flushTimers();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('data-state')).toBe('open');
  });

  it('renders multiple items', async () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
          <DropdownItem>Item 2</DropdownItem>
          <DropdownItem>Item 3</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await flushTimers();

    const items = screen
      .getAllByRole('button')
      .filter((element) => /^Item /.test(element.textContent || ''));
    expect(items).toHaveLength(3);
  });

  it('does not render content when closed', () => {
    render(
      <Dropdown>
        <DropdownTrigger>Open</DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Item 1</DropdownItem>
        </DropdownContent>
      </Dropdown>,
    );

    expect(screen.queryByText('Item 1')).toBeNull();
  });
});
