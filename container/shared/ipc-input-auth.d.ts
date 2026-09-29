export declare const IPC_INPUT_AUTH_VERSION: 1;

export declare function generateIpcAuthSecret(): string;

export declare function encodeAuthenticatedInput(
  secret: string,
  body: string,
): string;

export type DecodedInput =
  | { status: 'ok'; body: string }
  | { status: 'incomplete' }
  | {
      status: 'rejected';
      reason: 'malformed' | 'no-secret' | 'bad-mac';
    };

export declare function decodeAuthenticatedInput(
  secret: string,
  raw: string,
): DecodedInput;
