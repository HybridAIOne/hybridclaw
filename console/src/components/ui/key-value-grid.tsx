import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

function KeyValueGrid({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="key-value-grid"
      className={cn('grid grid-cols-2 gap-4 max-[1080px]:grid-cols-1', className)}
      {...props}
    />
  );
}

interface KeyValueItemProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}

function KeyValueItem({ label, value, className }: KeyValueItemProps) {
  return (
    <div
      data-slot="key-value-item"
      className={cn(
        'grid gap-1 p-3.5 rounded-md border border-line bg-panel-muted min-w-0',
        className,
      )}
    >
      <span className="text-muted">{label}</span>
      <strong className="block break-words [overflow-wrap:anywhere]">
        {value}
      </strong>
    </div>
  );
}

export { KeyValueGrid, KeyValueItem };
