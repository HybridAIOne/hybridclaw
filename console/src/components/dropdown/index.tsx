import {
  type ButtonHTMLAttributes,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import styles from './index.module.css';

type DropdownContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenToggle: () => void;
  triggerElement: HTMLButtonElement | null;
  contentElement: HTMLDivElement | null;
  setTriggerElement: (element: HTMLButtonElement | null) => void;
  setContentElement: (element: HTMLDivElement | null) => void;
  contentId: string;
} | null;

const DropdownContext = createContext<DropdownContextValue>(null);

function useDropdownContext(name: string) {
  const ctx = useContext(DropdownContext);
  if (!ctx) throw new Error(`${name} components must be used within Dropdown`);
  return ctx;
}

interface DropdownProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Dropdown({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: DropdownProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [triggerElement, setTriggerElement] =
    useState<HTMLButtonElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const contentId = useId();

  const isControlled = openProp !== undefined;
  const currentOpen = isControlled ? openProp : open;

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!isControlled) setOpen(newOpen);
      onOpenChange?.(newOpen);
    },
    [isControlled, onOpenChange],
  );

  const handleOpenToggle = useCallback(() => {
    handleOpenChange(!currentOpen);
  }, [currentOpen, handleOpenChange]);

  return (
    <DropdownContext.Provider
      value={{
        open: currentOpen,
        onOpenChange: handleOpenChange,
        onOpenToggle: handleOpenToggle,
        triggerElement,
        contentElement,
        setTriggerElement,
        setContentElement,
        contentId,
      }}
    >
      {children}
    </DropdownContext.Provider>
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
  const { open, onOpenChange, onOpenToggle, setTriggerElement, contentId } =
    useDropdownContext('DropdownTrigger');

  const classNames = [styles.trigger, className].filter(Boolean).join(' ');

  return (
    <button
      ref={setTriggerElement}
      type="button"
      className={classNames}
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={ariaLabel}
      title={title}
      data-state={open ? 'open' : 'closed'}
      onClick={onOpenToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          onOpenChange(true);
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
  const {
    open,
    onOpenChange,
    triggerElement,
    contentElement,
    setContentElement,
    contentId,
  } = useDropdownContext('DropdownContent');
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!open || !triggerElement || !contentElement) return;

    const updatePosition = () => {
      const triggerRect = triggerElement.getBoundingClientRect();
      const contentRect = contentElement.getBoundingClientRect();

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let x = triggerRect.left;
      let y = triggerRect.bottom + sideOffset;

      if (align === 'end') {
        x = triggerRect.right - contentRect.width;
      } else if (align === 'center') {
        x = triggerRect.left + (triggerRect.width - contentRect.width) / 2;
      }

      if (x + contentRect.width > viewportWidth - 8) {
        x = viewportWidth - contentRect.width - 8;
      }
      if (x < 8) x = 8;

      if (y + contentRect.height > viewportHeight - 8) {
        y = triggerRect.top - contentRect.height - sideOffset;
      }

      setPosition({ x, y });
    };

    requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, align, sideOffset, triggerElement, contentElement]);

  useEffect(() => {
    if (!open || !triggerElement || !contentElement) return;

    const focusFirstItem = window.setTimeout(() => {
      const firstItem = contentElement.querySelector<HTMLElement>(
        'button:not(:disabled)',
      );
      firstItem?.focus();
    }, 0);

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (triggerElement.contains(target)) return;
      if (contentElement.contains(target)) return;
      onOpenChange(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
        triggerElement.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusFirstItem);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange, triggerElement, contentElement]);

  if (!open) return null;

  const classNames = [styles.content, className].filter(Boolean).join(' ');

  return (
    <div
      ref={setContentElement}
      id={contentId}
      className={classNames}
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {children}
    </div>
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
  const { onOpenChange } = useDropdownContext('DropdownItem');

  const classNames = [styles.item, className].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={classNames}
      data-active={active ? 'true' : 'false'}
      onClick={() => {
        onSelect?.();
        onOpenChange(false);
      }}
    >
      {children}
    </button>
  );
}

export function DropdownSeparator({ className = '' }: { className?: string }) {
  return <hr className={className} />;
}
