import type { ReactNode } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';

/**
 * shadcn-style aliases mapped onto our existing Field primitives so
 * `<FormItem>`/`<FormLabel>`/`<FormControl>`/`<FormDescription>`/`<FormMessage>`
 * compositions work without renaming the underlying types. Pick whichever
 * naming convention reads better at the call site — they're interchangeable.
 */

export const FormItem = Field;
export const FormLabel = FieldLabel;
export const FormDescription = FieldDescription;
export const FormMessage = FieldError;

export type FormControlProps = {
  children: ReactNode;
};

/**
 * shadcn's `<FormControl>` clones its child through Radix's `Slot` to
 * inject aria attributes (`id`, `aria-invalid`, `aria-describedby`). Our
 * primitives (`Input`, `Textarea`, `NativeSelect`, `Switch`, `Checkbox`,
 * etc.) already wire themselves through `useFieldControlProps` and pick
 * up those attributes automatically from `FieldContext`, so this
 * component is a transparent pass-through — provided purely so shadcn
 * compositions copy-paste verbatim. Use it when you want the visual
 * parity; it has no runtime effect beyond rendering its child.
 */
export function FormControl({ children }: FormControlProps): ReactNode {
  return children;
}
