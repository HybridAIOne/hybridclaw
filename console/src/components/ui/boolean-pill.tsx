import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const booleanPillVariants = cva(
  'inline-flex items-center gap-2 w-fit px-2.5 py-1.5 border rounded-full text-[0.82rem] font-semibold lowercase',
  {
    variants: {
      state: {
        on: 'bg-success-soft border-success-border text-success',
        off: 'bg-panel-muted border-line-strong text-muted',
      },
    },
    defaultVariants: { state: 'off' },
  },
);

interface BooleanPillProps {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  className?: string;
}

function BooleanPill({
  value,
  trueLabel,
  falseLabel,
  className,
}: BooleanPillProps) {
  const label = value ? (trueLabel ?? 'on') : (falseLabel ?? 'off');
  const state = value ? 'on' : 'off';

  return (
    <span
      data-slot="boolean-pill"
      className={cn(booleanPillVariants({ state, className }))}
    >
      <span className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}

export { BooleanPill, booleanPillVariants };
