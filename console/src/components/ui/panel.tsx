import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const panelVariants = cva('p-5 rounded-lg border border-line', {
  variants: {
    accent: {
      default: 'bg-panel',
      warm: 'bg-panel-muted',
    },
  },
  defaultVariants: { accent: 'default' },
});

interface PanelProps
  extends React.ComponentProps<'section'>,
    VariantProps<typeof panelVariants> {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}

function Panel({
  title,
  subtitle,
  accent,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <section
      data-slot="panel"
      className={cn(panelVariants({ accent, className }))}
      {...props}
    >
      {title ? (
        <div className="mb-4">
          <h4 className="m-0 font-semibold tracking-[-0.02em] text-base">
            {title}
          </h4>
          {subtitle ? <p className="m-0 text-muted">{subtitle}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export { Panel, panelVariants };
