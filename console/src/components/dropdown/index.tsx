import {
  createContext,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import styles from './index.module.css';

type DropdownContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenToggle: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  contentId: string;
  triggerId: string;
} | null;

const DropdownContext = createContext<DropdownContextValue>(null);

function useDropdownContext(name: string) {
  const ctx = useContext(DropdownContext);
  if (!ctx) throw new Error(`${name} components must be used within Dropdown`);
  return ctx;
}

function useId() {
  return useRef(`dropdown-${Math.random().toString(36).slice(2, 9)}`).current;
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
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentId = useId();
  const triggerId = useId();

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
        triggerRef,
        contentId,
        triggerId,
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
  const { open, onOpenChange, onOpenToggle, triggerRef, contentId, triggerId } =
    useDropdownContext('DropdownTrigger');

  const classNames = [styles.trigger, className].filter(Boolean).join(' ');

  return (
    <button
      ref={triggerRef as RefObject<HTMLButtonElement>}
      type="button"
      id={triggerId}
      className={classNames}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
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
  const { open, onOpenChange, triggerRef, contentId, triggerId } =
    useDropdownContext('DropdownContent');
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!open || !triggerRef.current || !contentRef.current) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const content = contentRef.current;
      if (!trigger || !content) return;

      const triggerRect = trigger.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();

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
  }, [open, align, sideOffset, triggerRef]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (triggerRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange, triggerRef]);

  if (!open) return null;

  const classNames = [styles.content, className].filter(Boolean).join(' ');

  return (
    <div
      ref={contentRef}
      id={contentId}
      role="menu"
      aria-labelledby={triggerId}
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
  onSelect?: () => void;
}

export function DropdownItem({
  children,
  className = '',
  onSelect,
}: DropdownItemProps) {
  const { onOpenChange } = useDropdownContext('DropdownItem');

  const classNames = [styles.item, className].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      role="menuitem"
      className={classNames}
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
