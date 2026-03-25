import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn('flex items-start justify-between gap-[18px]', className)}
    >
      <div>
        <h3 className="m-0 font-semibold tracking-[-0.02em] text-[clamp(1.6rem,2vw,2rem)]">
          {title}
        </h3>
        {description ? <p className="m-0 text-muted">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2.5 flex-wrap">{actions}</div>
      ) : null}
    </div>
  );
}

export { PageHeader };
