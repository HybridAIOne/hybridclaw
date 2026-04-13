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

import type { ComponentProps } from 'react';
import { DialogClose, DialogContent } from '../dialog';

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

export function AlertDialogCancel(
  props: ComponentProps<typeof DialogClose>,
) {
  return <DialogClose className="ghost-button" {...props} />;
}

export function AlertDialogAction(
  props: ComponentProps<typeof DialogClose> & {
    variant?: 'default' | 'destructive';
  },
) {
  const { variant = 'default', className, ...rest } = props;
  return (
    <DialogClose
      className={className ?? (variant === 'destructive' ? 'danger-button' : 'primary-button')}
      {...rest}
    />
  );
}
