import type readline from 'node:readline';

type InternalReadline = readline.Interface & {
  _insertString?: (value: string) => void;
  _ttyWrite?: (chunk: string, key: readline.Key) => void;
};

const SHIFT_RETURN_SEQUENCES = new Set(['\x1b[13;2u', '\x1b[13;2~']);
const SPLIT_SHIFT_RETURN_SEQUENCE = '\x1b[27;2;13~';
const SPLIT_SHIFT_RETURN_PREFIX = '\x1b[27;2;';

function buildFallbackKey(sequence: string): readline.Key {
  return {
    sequence,
    name: 'undefined',
    ctrl: false,
    meta: false,
    shift: false,
  };
}

export function isTuiMultilineEnterKey(key: readline.Key | undefined): boolean {
  if (!key) return false;

  if (SHIFT_RETURN_SEQUENCES.has(String(key.sequence || ''))) {
    return true;
  }

  if ((key.name === 'return' || key.name === 'enter') && key.shift === true) {
    return true;
  }

  if (
    key.sequence === '\n' &&
    key.name === 'enter' &&
    key.ctrl !== true &&
    key.meta !== true &&
    key.shift !== true
  ) {
    return true;
  }

  return (
    key.sequence === '\n' &&
    key.ctrl === true &&
    key.name === 'j' &&
    key.meta !== true &&
    key.shift !== true
  );
}

export class TuiMultilineInputController {
  private readonly rl: InternalReadline;
  private readonly originalTtyWrite: InternalReadline['_ttyWrite'] | undefined;
  private readonly closeHandler: () => void;
  private installedTtyWrite: InternalReadline['_ttyWrite'] | undefined;
  private pendingSplitShiftReturnSequence = '';

  constructor(params: { rl: readline.Interface }) {
    this.rl = params.rl as InternalReadline;
    this.originalTtyWrite = this.rl._ttyWrite?.bind(this.rl);
    this.closeHandler = () => {
      this.dispose();
    };
  }

  install(): void {
    if (
      !this.originalTtyWrite ||
      this.installedTtyWrite ||
      typeof this.rl._insertString !== 'function'
    ) {
      return;
    }

    this.installedTtyWrite = (chunk: string, key: readline.Key) => {
      const rawSequence = String(key.sequence ?? chunk ?? '');
      if (this.pendingSplitShiftReturnSequence) {
        const nextSequence = `${this.pendingSplitShiftReturnSequence}${rawSequence}`;
        if (SPLIT_SHIFT_RETURN_SEQUENCE.startsWith(nextSequence)) {
          this.pendingSplitShiftReturnSequence = nextSequence;
          if (nextSequence === SPLIT_SHIFT_RETURN_SEQUENCE) {
            this.pendingSplitShiftReturnSequence = '';
            this.rl._insertString?.('\n');
          }
          return;
        }

        this.originalTtyWrite?.(
          this.pendingSplitShiftReturnSequence,
          buildFallbackKey(this.pendingSplitShiftReturnSequence),
        );
        this.pendingSplitShiftReturnSequence = '';
      }

      if (rawSequence === SPLIT_SHIFT_RETURN_PREFIX) {
        this.pendingSplitShiftReturnSequence = rawSequence;
        return;
      }

      if (!isTuiMultilineEnterKey(key)) {
        this.originalTtyWrite?.(chunk, key);
        return;
      }

      this.rl._insertString?.('\n');
    };

    this.rl._ttyWrite = this.installedTtyWrite;
    this.rl.on('close', this.closeHandler);
  }

  dispose(): void {
    if (this.pendingSplitShiftReturnSequence && this.originalTtyWrite) {
      this.originalTtyWrite(
        this.pendingSplitShiftReturnSequence,
        buildFallbackKey(this.pendingSplitShiftReturnSequence),
      );
    }
    this.pendingSplitShiftReturnSequence = '';
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
