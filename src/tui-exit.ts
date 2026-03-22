import type readline from 'node:readline';

type TuiExitAction = 'warn' | 'exit';

type InternalReadline = readline.Interface & {
  line: string;
  _ttyWrite?: (chunk: string, key: readline.Key) => void;
};

function isExitKeypress(key: readline.Key, line: string): boolean {
  if (key.ctrl !== true) return false;
  if (key.name === 'c') return true;
  return key.name === 'd' && line.length === 0;
}

export function formatTuiExitWarning(exitWindowMs = 5000): string {
  const seconds = Math.max(1, Math.ceil(exitWindowMs / 1000));
  return `Press Ctrl-C or Ctrl-D again within ${seconds} second${seconds === 1 ? '' : 's'} to exit.`;
}

export function resolveTuiExitAction(params: {
  key: readline.Key;
  line: string;
  now: number;
  lastExitAttemptAt: number;
  exitWindowMs?: number;
}): { action: TuiExitAction; nextLastExitAttemptAt: number } | null {
  if (!isExitKeypress(params.key, params.line)) {
    return null;
  }

  const exitWindowMs = Math.max(1, Math.floor(params.exitWindowMs ?? 5000));
  if (
    params.lastExitAttemptAt > 0 &&
    params.now - params.lastExitAttemptAt <= exitWindowMs
  ) {
    return {
      action: 'exit',
      nextLastExitAttemptAt: params.lastExitAttemptAt,
    };
  }

  return {
    action: 'warn',
    nextLastExitAttemptAt: params.now,
  };
}

export class TuiExitController {
  private readonly rl: InternalReadline;
  private readonly onWarn: () => void;
  private readonly onExit: () => void;
  private readonly now: () => number;
  private readonly exitWindowMs: number;
  private readonly originalTtyWrite: InternalReadline['_ttyWrite'] | undefined;
  private readonly closeHandler: () => void;
  private installedTtyWrite: InternalReadline['_ttyWrite'] | undefined;
  private lastExitAttemptAt = 0;

  constructor(params: {
    rl: readline.Interface;
    onWarn: () => void;
    onExit: () => void;
    now?: () => number;
    exitWindowMs?: number;
  }) {
    this.rl = params.rl as InternalReadline;
    this.onWarn = params.onWarn;
    this.onExit = params.onExit;
    this.now = params.now ?? (() => Date.now());
    this.exitWindowMs = Math.max(1, Math.floor(params.exitWindowMs ?? 5000));
    this.originalTtyWrite = this.rl._ttyWrite?.bind(this.rl);
    this.closeHandler = () => {
      this.dispose();
    };
  }

  install(): void {
    if (!this.originalTtyWrite || this.installedTtyWrite) return;

    this.installedTtyWrite = (chunk: string, key: readline.Key) => {
      const decision = resolveTuiExitAction({
        key,
        line: this.rl.line,
        now: this.now(),
        lastExitAttemptAt: this.lastExitAttemptAt,
        exitWindowMs: this.exitWindowMs,
      });
      if (!decision) {
        this.originalTtyWrite?.(chunk, key);
        return;
      }

      this.lastExitAttemptAt = decision.nextLastExitAttemptAt;
      if (decision.action === 'exit') {
        this.onExit();
        return;
      }

      this.onWarn();
    };

    this.rl._ttyWrite = this.installedTtyWrite;
    this.rl.on('close', this.closeHandler);
  }

  dispose(): void {
    if (
      this.installedTtyWrite &&
      this.rl._ttyWrite === this.installedTtyWrite &&
      this.originalTtyWrite
    ) {
      this.rl._ttyWrite = this.originalTtyWrite;
    }
    this.installedTtyWrite = undefined;
    this.rl.off('close', this.closeHandler);
  }
}
