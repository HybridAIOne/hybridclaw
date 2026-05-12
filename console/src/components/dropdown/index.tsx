import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Popover, PopoverContent, usePopoverContext } from '../popover';
import styles from './index.module.css';

interface DropdownProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Dropdown({
  children,
  open,
  defaultOpen,
  onOpenChange,
}: DropdownProps) {
  return (
    <Popover open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {children}
    </Popover>
  );
}

interface DropdownTriggerProps
  extends Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'aria-label' | 'title'
  > {
  children: ReactNode;
  className?: string;
}

export function DropdownTrigger({
  children,
  className = '',
  'aria-label': ariaLabel,
  title,
}: DropdownTriggerProps) {
  const ctx = usePopoverContext('DropdownTrigger');
  return (
    <button
      ref={ctx.setTriggerEl}
      type="button"
      className={cx(styles.trigger, className)}
      aria-haspopup="menu"
      aria-expanded={ctx.open}
      aria-controls={ctx.contentId}
      aria-label={ariaLabel}
      title={title}
      data-state={ctx.open ? 'open' : 'closed'}
      onClick={ctx.toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          ctx.setOpen(true);
        }
      }}
    >
      {children}
    </button>
  );
}

interface DropdownContentProps {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

export function DropdownContent({
  children,
  className = '',
  align = 'start',
  sideOffset = 4,
}: DropdownContentProps) {
  return (
    <PopoverContent
      role="menu"
      align={align}
      sideOffset={sideOffset}
      focusOnOpen="first-button"
      className={cx(styles.content, className)}
    >
      {children}
    </PopoverContent>
  );
}

interface DropdownItemProps {
  children: ReactNode;
  className?: string;
  active?: boolean;
  onSelect?: () => void;
}

export function DropdownItem({
  children,
  className = '',
  active = false,
  onSelect,
}: DropdownItemProps) {
  const ctx = usePopoverContext('DropdownItem');
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(styles.item, className)}
      data-active={active ? 'true' : 'false'}
      onClick={() => {
        onSelect?.();
        ctx.setOpen(false);
      }}
    >
      {children}
    </button>
  );
}

export function DropdownSeparator({ className = '' }: { className?: string }) {
  return <hr className={className} />;
}
