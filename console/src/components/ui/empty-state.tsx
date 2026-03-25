import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const emptyStateVariants = cva('px-4 py-3.5 rounded-md border', {
  variants: {
    variant: {
      default: 'border-line bg-panel-muted text-muted',
      error: 'border-danger-border bg-danger-soft text-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});

function EmptyState({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof emptyStateVariants>) {
  return (
    <div
      data-slot="empty-state"
      className={cn(emptyStateVariants({ variant, className }))}
      {...props}
    />
  );
}

export { EmptyState, emptyStateVariants };
