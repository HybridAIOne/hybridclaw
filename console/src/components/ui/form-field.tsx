import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface FormFieldProps extends React.ComponentProps<'label'> {
  label: string;
  children: ReactNode;
}

const inputStyles =
  '[&_input,&_select,&_textarea]:w-full [&_input,&_select,&_textarea]:px-3 [&_input,&_select,&_textarea]:py-2.5 [&_input,&_select,&_textarea]:rounded-sm [&_input,&_select,&_textarea]:border [&_input,&_select,&_textarea]:border-line-strong [&_input,&_select,&_textarea]:bg-panel [&_input,&_select,&_textarea]:text-foreground [&_textarea]:resize-y';

function FormField({ label, className, children, ...props }: FormFieldProps) {
  return (
    <label
      data-slot="form-field"
      className={cn('grid gap-2', inputStyles, className)}
      {...props}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

export { FormField };
