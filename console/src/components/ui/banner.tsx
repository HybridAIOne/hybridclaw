import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const bannerVariants = cva('px-4 py-3.5 rounded-md border', {
  variants: {
    variant: {
      error: 'bg-danger-soft border-danger-border text-danger',
      success: 'bg-success-soft border-success-border text-success',
    },
  },
  defaultVariants: { variant: 'error' },
});

function Banner({
  className,
  variant,
  ...props
}: React.ComponentProps<'p'> & VariantProps<typeof bannerVariants>) {
  return (
    <p
      data-slot="banner"
      className={cn(bannerVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Banner, bannerVariants };
