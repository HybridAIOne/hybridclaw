export type AdminTerminalClientMessage =
  | {
      type: 'auth';
      token: string;
    }
  | {
      type: 'input';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    };

export type AdminTerminalServerMessage =
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'exit';
      exitCode: number | null;
      signal: number | null;
    };
