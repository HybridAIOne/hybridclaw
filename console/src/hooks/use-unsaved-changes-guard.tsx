import { useBlocker } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '../components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';

export type UseUnsavedChangesGuardOptions = {
  /** Block in-app navigation + beforeunload whenever this is true. */
  isDirty: boolean;
  /** Dialog heading. Defaults to "Discard unsaved changes?". */
  title?: string;
  /** Body copy. */
  description?: ReactNode;
  /** Label for the cancel button. Defaults to "Keep editing". */
  keepLabel?: string;
  /** Label for the destructive confirm button. Defaults to "Discard and leave". */
  discardLabel?: string;
};

export type UseUnsavedChangesGuardReturn = {
  /**
   * Render this in your component tree. The dialog opens automatically when
   * the user attempts to navigate while `isDirty` is true; clicking
   * "Keep editing" cancels the nav, clicking "Discard and leave" proceeds.
   */
  dialog: ReactNode;
};

/**
 * Wraps TanStack Router's `useBlocker` with an alertdialog so unsaved edits
 * survive sidebar clicks and browser back/forward. Also hooks the
 * `beforeunload` event so window close / tab close prompts the user.
 *
 *   const { isDirty } = useFormDraft({ source: query.data });
 *   const { dialog } = useUnsavedChangesGuard({ isDirty });
 *
 *   return <>{dialog}<MainForm /></>;
 */
export function useUnsavedChangesGuard(
  opts: UseUnsavedChangesGuardOptions,
): UseUnsavedChangesGuardReturn {
  const {
    isDirty,
    title = 'Discard unsaved changes?',
    description = 'You have unsaved edits. Leaving this page will discard them.',
    keepLabel = 'Keep editing',
    discardLabel = 'Discard and leave',
  } = opts;

  const blocker = useBlocker({
    shouldBlockFn: ({ next, current }) =>
      isDirty && next.pathname !== current.pathname,
    enableBeforeUnload: () => isDirty,
    withResolver: true,
  });

  const isBlocked = blocker.status === 'blocked';

  const dialog = (
    <Dialog
      open={isBlocked}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
    >
      <DialogContent role="alertdialog" size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              if (blocker.status === 'blocked') blocker.reset();
            }}
          >
            {keepLabel}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (blocker.status === 'blocked') blocker.proceed();
            }}
          >
            {discardLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { dialog };
}
