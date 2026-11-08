/** Gateway-owned delegation lineage for conflict state, never an approval grant. */
export interface FileWriteGuardContext {
  /** Root worker session whose write conflicts this delegated worker shares. */
  fileWriteGuardSessionId?: string;
  /** Gateway-owned root request; a model-authored delegation cannot replace it. */
  fileWriteGuardUserPrompt?: string;
}

/** Controller-authenticated request context; never supplied by model tool args. */
export interface FileWriteGuardReceipt {
  fileWriteGuardProof?: string;
}

export interface FileWriteGuardRequest {
  sessionId: string;
  requestId?: string;
  fileWriteGuardSessionId?: string;
}

export declare function encodeFileWriteGuardContext(
  secret: string,
  request: FileWriteGuardRequest,
  userPrompt: string,
): string;

export declare function decodeFileWriteGuardContext(
  secret: string,
  raw: unknown,
  request: FileWriteGuardRequest,
): FileWriteGuardContext | null;
