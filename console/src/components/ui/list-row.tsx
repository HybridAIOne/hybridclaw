import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface ListRowProps {
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  className?: string;
}

function ListRow({ title, meta, status, className }: ListRowProps) {
  return (
    <div
      data-slot="list-row"
      className={cn(
        'flex items-start justify-between gap-3 px-3.5 py-3 rounded-md border border-line bg-panel',
        className,
      )}
    >
      <div className="grid gap-1 flex-auto min-w-0">
        <strong className="block leading-[1.25] break-words [overflow-wrap:anywhere]">
          {title}
        </strong>
        {meta ? (
          <small className="block leading-[1.35] text-muted">{meta}</small>
        ) : null}
      </div>
      {status ? (
        <span className="flex-none pl-3 whitespace-nowrap">{status}</span>
      ) : null}
    </div>
  );
}

export { ListRow };
