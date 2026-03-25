import { cn } from '../../lib/utils';

interface BooleanToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}

function BooleanToggle({
  value,
  onChange,
  trueLabel,
  falseLabel,
  disabled,
  ariaLabel,
  className,
}: BooleanToggleProps) {
  return (
    <fieldset
      data-slot="boolean-toggle"
      className={cn(
        'inline-flex items-center w-fit border border-line-strong rounded-full overflow-hidden bg-panel',
        className,
      )}
      aria-label={ariaLabel}
    >
      <button
        className={cn(
          'px-3 py-2 border-0 bg-transparent text-muted cursor-pointer lowercase disabled:cursor-default disabled:opacity-65',
          value && 'bg-success-soft text-success',
        )}
        type="button"
        disabled={disabled}
        aria-pressed={value}
        onClick={() => {
          if (!value) onChange(true);
        }}
      >
        {trueLabel ?? 'on'}
      </button>
      <button
        className={cn(
          'px-3 py-2 border-y-0 border-r-0 border-l border-line-strong bg-transparent text-muted cursor-pointer lowercase disabled:cursor-default disabled:opacity-65',
          !value && 'bg-panel-muted text-foreground',
        )}
        type="button"
        disabled={disabled}
        aria-pressed={!value}
        onClick={() => {
          if (value) onChange(false);
        }}
      >
        {falseLabel ?? 'off'}
      </button>
    </fieldset>
  );
}

export { BooleanToggle };
