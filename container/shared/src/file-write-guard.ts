/** Gateway-owned delegation lineage for conflict state, never an approval grant. */
export interface FileWriteGuardContext {
  /** Root worker session whose write conflicts this delegated worker shares. */
  fileWriteGuardSessionId?: string;
}
