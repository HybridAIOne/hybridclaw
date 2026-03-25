import { cn } from '../../lib/utils';

interface SelectableRowProps extends React.ComponentProps<'button'> {
  active: boolean;
}

function SelectableRow({
  active,
  className,
  ...props
}: SelectableRowProps) {
  return (
    <button
      data-slot="selectable-row"
      type="button"
      className={cn(
        'flex items-start justify-between gap-3 px-3.5 py-3 rounded-md border border-line bg-panel w-full text-left cursor-pointer min-w-0',
        active && 'border-accent bg-accent-soft',
        className,
      )}
      {...props}
    />
  );
}

export { SelectableRow };
