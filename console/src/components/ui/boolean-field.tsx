import { cn } from '../../lib/utils';
import { BooleanToggle } from './boolean-toggle';

interface BooleanFieldProps {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  disabled?: boolean;
  className?: string;
}

function BooleanField({
  label,
  value,
  onChange,
  trueLabel,
  falseLabel,
  disabled,
  className,
}: BooleanFieldProps) {
  return (
    <div
      data-slot="boolean-field"
      className={cn('grid gap-2 items-start', className)}
    >
      <span>{label}</span>
      <BooleanToggle
        value={value}
        onChange={onChange}
        trueLabel={trueLabel}
        falseLabel={falseLabel}
        disabled={disabled}
        ariaLabel={label}
      />
    </div>
  );
}

export { BooleanField };
