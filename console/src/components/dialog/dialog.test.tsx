import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './index';

// jsdom does not implement the Web Animations API.
// Polyfill getAnimations so the hook in useAnimationsFinished works.
if (!HTMLElement.prototype.getAnimations) {
  HTMLElement.prototype.getAnimations = () => [];
}

function TestDialog(props: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <button
            type="button"
            onClick={() => {
              props.onConfirm?.();
              setOpen(false);
            }}
          >
            Yes
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Drawer harness
// ---------------------------------------------------------------------------

function TestDrawer(props: {
  initialOpen?: boolean;
  side?: 'left' | 'right' | 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  return (
    <Dialog open={open} onOpenChange={setOpen} isDrawer>
      <button type="button" onClick={() => setOpen(true)}>
        Open drawer
      </button>
      <DialogContent side={props.side ?? 'right'}>
        <DialogHeader>
          <DialogTitle>Drawer title</DialogTitle>
        </DialogHeader>
        <p>Drawer body</p>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens when trigger is clicked and closes on DialogClose', () => {
    render(<TestDialog />);

    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Confirm')).toBeTruthy();
    expect(screen.getByText('Are you sure?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fires the confirm callback', () => {
    const onConfirm = vi.fn();
    render(<TestDialog onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('has correct aria attributes', () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('closes when the backdrop is clicked', () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    // The backdrop is the sibling before the viewport that wraps the dialog.
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement?.previousElementSibling;
    expect(backdrop).toBeTruthy();
    act(() => {
      fireEvent.click(backdrop as Element);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when Escape is pressed', () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drawer mode
// ---------------------------------------------------------------------------

describe('Dialog — drawer mode', () => {
  it('DialogContent renders a <section> with role="dialog" when isDrawer is true', () => {
    render(<TestDrawer initialOpen={true} />);
    // The panel is a <section> in drawer mode (in document.body portal).
    const section = document.body.querySelector('section[role="dialog"]');
    expect(section).not.toBeNull();
  });

  it('section has data-state="open" when open', () => {
    render(<TestDrawer initialOpen={true} />);
    const section = document.body.querySelector('section[role="dialog"]');
    expect(section?.getAttribute('data-state')).toBe('open');
  });

  it('section has data-state="closed" when not open', () => {
    render(<TestDrawer initialOpen={false} />);
    const section = document.body.querySelector('section[role="dialog"]');
    expect(section?.getAttribute('data-state')).toBe('closed');
  });

  it('side prop sets data-side="left" on the section', () => {
    render(<TestDrawer initialOpen={true} side="left" />);
    const section = document.body.querySelector('section[role="dialog"]');
    expect(section?.getAttribute('data-side')).toBe('left');
  });

  it('side prop sets data-side="right" on the section', () => {
    render(<TestDrawer initialOpen={true} side="right" />);
    const section = document.body.querySelector('section[role="dialog"]');
    expect(section?.getAttribute('data-side')).toBe('right');
  });

  it('Escape closes the drawer', () => {
    render(<TestDrawer initialOpen={true} />);
    const section = document.body.querySelector('section[role="dialog"]');
    expect(section?.getAttribute('data-state')).toBe('open');

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(
      document.body.querySelector('section[role="dialog"]')?.getAttribute('data-state'),
    ).toBe('closed');
  });

  it('clicking the overlay closes the drawer', () => {
    render(<TestDrawer initialOpen={true} />);
    expect(
      document.body.querySelector('section[role="dialog"]')?.getAttribute('data-state'),
    ).toBe('open');

    const overlay = document.body.querySelector('[data-sheet="overlay"]') as HTMLElement;
    expect(overlay).not.toBeNull();
    act(() => {
      fireEvent.click(overlay);
    });

    expect(
      document.body.querySelector('section[role="dialog"]')?.getAttribute('data-state'),
    ).toBe('closed');
  });

  it('aria-labelledby links to DialogTitle content', () => {
    render(<TestDrawer initialOpen={true} />);
    const section = document.body.querySelector('section[role="dialog"]');
    const labelledById = section?.getAttribute('aria-labelledby') ?? '';
    expect(labelledById).not.toBe('');
    const titleEl = document.getElementById(labelledById);
    expect(titleEl?.textContent).toBe('Drawer title');
  });

  it('drawer stays mounted (never unmounts) after close — no JS unmount-on-animation-end', () => {
    // For a modal dialog, the panel is removed from the DOM after the exit
    // animation completes.  For a drawer, the panel is always mounted and
    // open/close is handled entirely by CSS — there is no transient exiting
    // state that would unmount and re-mount the panel.
    render(<TestDrawer initialOpen={true} />);

    const sectionOnOpen = document.body.querySelector('section[role="dialog"]');
    expect(sectionOnOpen).not.toBeNull();
    expect(sectionOnOpen?.getAttribute('data-state')).toBe('open');

    // Close via Escape — the quickest way to trigger onOpenChange(false).
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    // The section must still be in the DOM (drawer is never unmounted).
    const sectionAfterClose = document.body.querySelector('section[role="dialog"]');
    expect(sectionAfterClose).not.toBeNull();
    expect(sectionAfterClose?.getAttribute('data-state')).toBe('closed');

    // Element identity is unchanged — it was never unmounted and remounted.
    expect(sectionAfterClose).toBe(sectionOnOpen);
  });
});
