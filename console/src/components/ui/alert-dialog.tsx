/**
 * AlertDialog — shadcn/Base UI-style aliases over the Dialog primitives.
 *
 * AlertDialogContent sets role="alertdialog" automatically so assistive
 * technologies announce the confirmation prompt immediately.
 *
 * Usage:
 *   <AlertDialog open={open} onOpenChange={setOpen}>
 *     <AlertDialogContent size="sm">
 *       <AlertDialogHeader>
 *         <AlertDialogTitle>Delete item?</AlertDialogTitle>
 *         <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
 *       </AlertDialogHeader>
 *       <AlertDialogFooter>
 *         <AlertDialogCancel>Cancel</AlertDialogCancel>
 *         <AlertDialogAction variant="destructive" onClick={onConfirm}>
 *           Delete
 *         </AlertDialogAction>
 *       </AlertDialogFooter>
 *     </AlertDialogContent>
 *   </AlertDialog>
 */

import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { DialogContent, useDialogContext } from '../dialog';

// ---------------------------------------------------------------------------
// Re-exports (structural aliases — no behavioural difference)
// ---------------------------------------------------------------------------

export { Dialog as AlertDialog } from '../dialog';

export function AlertDialogContent(
  props: Omit<ComponentProps<typeof DialogContent>, 'role'>,
) {
  return <DialogContent {...props} role="alertdialog" />;
}

export {
  DialogDescription as AlertDialogDescription,
  DialogFooter as AlertDialogFooter,
  DialogHeader as AlertDialogHeader,
  DialogTitle as AlertDialogTitle,
} from '../dialog';

// ---------------------------------------------------------------------------
// AlertDialogCancel — closes the dialog, styled as ghost-button by default
// ---------------------------------------------------------------------------

export function AlertDialogCancel(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { onOpenChange } = useDialogContext();
  const { children, className, onClick, ...rest } = props;

  return (
    <button
      {...rest}
      type="button"
      className={className ?? 'ghost-button'}
      onClick={(e) => {
        onClick?.(e);
        onOpenChange(false);
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// AlertDialogAction — closes the dialog and fires the action
// ---------------------------------------------------------------------------

export function AlertDialogAction(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
    variant?: 'default' | 'destructive';
  },
) {
  const { onOpenChange } = useDialogContext();
  const { children, className, onClick, variant = 'default', ...rest } = props;

  return (
    <button
      {...rest}
      type="button"
      className={
        className ??
        (variant === 'destructive' ? 'danger-button' : 'primary-button')
      }
      onClick={(e) => {
        onClick?.(e);
        onOpenChange(false);
      }}
    >
      {children}
    </button>
  );
}
