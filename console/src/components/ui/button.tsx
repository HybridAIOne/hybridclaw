import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-medium cursor-pointer disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'px-3 py-[9px] rounded-sm border border-accent bg-accent text-white',
        ghost:
          'px-3 py-[9px] rounded-sm border border-line-strong bg-panel text-foreground',
        danger:
          'px-3 py-[9px] rounded-sm border border-danger-border bg-danger-soft text-danger',
        link: 'p-0 border-0 bg-transparent text-foreground font-bold text-left hover:text-accent',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

function Button({
  className,
  variant,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
