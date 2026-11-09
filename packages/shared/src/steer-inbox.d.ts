export interface SteerNote {
  id: string;
  content: string;
}

export declare function steerInboxDirName(requestId: string): string;

export declare function closedSteerInboxDirName(requestId: string): string;

export declare function isSteerInboxEntryName(name: string): boolean;

export declare function steerNoteFileName(sequence: number, id: string): string;

export declare function encodeSteerNote(
  secret: string,
  note: SteerNote & { requestId: string },
): string;

export declare function decodeSteerNote(
  secret: string,
  requestId: string,
  raw: string,
): SteerNote | null;
