/** Extract a human-readable message from an unknown thrown value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message || 'An unexpected error occurred.';
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (
      (error as { message: string }).message || 'An unexpected error occurred.'
    );
  }
  return String(error);
}
