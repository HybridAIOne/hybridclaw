import fs from 'node:fs';
import readline from 'node:readline/promises';
import tty from 'node:tty';

type MutableReadlineInterface = readline.Interface & {
  _writeToOutput?: (value: string) => void;
};

function stripAnsiEscapeSequences(value: string): string {
  let result = '';

  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b) {
      result += value[index] ?? '';
      continue;
    }

    if (value[index + 1] !== '[') {
      continue;
    }

    index += 2;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        break;
      }
      index += 1;
    }
  }

  return result;
}

function normalizeSecretPrompt(prompt: string): string {
  const plain = stripAnsiEscapeSequences(String(prompt || '')).trim();
  if (!plain) {
    return '🔒 Paste secret: ';
  }

  let label = plain
    .replace(/^🔒\s*/u, '')
    .replace(/:\s*$/, '')
    .trim();
  if (!/^paste\s+/i.test(label)) {
    label = `Paste ${label}`;
  }
  return `🔒 ${label}: `;
}

function ensureInteractiveTerminal(missingMessage?: string): void {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error(missingMessage || 'Interactive terminal required.');
}

function shouldUseDedicatedSecretTty(): boolean {
  return process.stdin.listenerCount('data') > 0;
}

function reportSecretTtyCleanupFailure(
  target: 'input' | 'output',
  error: unknown,
): void {
  console.error(
    `[hybridclaw] failed to close dedicated secret TTY ${target} descriptor:`,
    error,
  );
}

function openDedicatedSecretTty(): {
  input: tty.ReadStream;
  output: tty.WriteStream;
  close: () => void;
} | null {
  const inputPath = process.platform === 'win32' ? 'CONIN$' : '/dev/tty';
  const outputPath = process.platform === 'win32' ? 'CONOUT$' : '/dev/tty';
  let inputFd: number | null = null;
  let outputFd: number | null = null;

  try {
    inputFd = fs.openSync(inputPath, 'r');
    outputFd = fs.openSync(outputPath, 'w');
    const input = new tty.ReadStream(inputFd);
    const output = new tty.WriteStream(outputFd);
    let closed = false;

    return {
      input,
      output,
      close: () => {
        if (closed) return;
        closed = true;
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    if (inputFd !== null) {
      try {
        fs.closeSync(inputFd);
      } catch (error) {
        reportSecretTtyCleanupFailure('input', error);
      }
    }
    if (outputFd !== null && outputFd !== inputFd) {
      try {
        fs.closeSync(outputFd);
      } catch (error) {
        reportSecretTtyCleanupFailure('output', error);
      }
    }
    return null;
  }
}

async function promptForSecretInputFallback(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function isSecretInputCancel(char: string): boolean {
  return char === '\u0003';
}

function isSecretInputSubmit(char: string): boolean {
  return char === '\r' || char === '\n';
}

function isSecretInputBackspace(char: string): boolean {
  return char === '\u007f' || char === '\b';
}

function isSecretInputPrintable(char: string): boolean {
  return char >= ' ';
}

async function readHiddenSecretFromTty(
  prompt: string,
  ttyInput: NodeJS.ReadStream,
  ttyOutput: NodeJS.WriteStream,
): Promise<string> {
  ttyOutput.write(prompt);
  const previousRawMode = ttyInput.isRaw;
  // `isPaused()` can still report `false` before the stream has entered
  // flowing mode, so key cleanup off the previous flowing state instead.
  const previousFlowingState = ttyInput.readableFlowing;
  ttyInput.setRawMode(true);
  ttyInput.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      ttyInput.off('data', handleData);
      ttyInput.setRawMode(previousRawMode ?? false);
      if (previousFlowingState !== true) {
        ttyInput.pause();
      }
      ttyOutput.write('\n');
    };

    const handleData = (chunk: string | Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (isSecretInputCancel(char)) {
          cleanup();
          reject(new Error('Prompt cancelled.'));
          return;
        }
        if (isSecretInputSubmit(char)) {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (isSecretInputBackspace(char)) {
          value = value.slice(0, -1);
          continue;
        }
        if (isSecretInputPrintable(char)) {
          value += char;
        }
      }
    };

    ttyInput.on('data', handleData);
  });
}

async function promptForSecretInputWithReadline(
  rl: readline.Interface,
  prompt: string,
  missingMessage?: string,
): Promise<string> {
  const mutableRl = rl as MutableReadlineInterface;
  if (
    typeof mutableRl.pause === 'function' &&
    typeof mutableRl.resume === 'function'
  ) {
    mutableRl.pause();
    try {
      return await promptForSecretInput({ prompt, missingMessage });
    } finally {
      mutableRl.resume();
    }
  }

  const originalWriteToOutput = mutableRl._writeToOutput?.bind(mutableRl);
  if (!originalWriteToOutput) {
    return (await rl.question(prompt)).trim();
  }

  let promptWritten = false;
  mutableRl._writeToOutput = (value: string) => {
    if (!promptWritten && value.includes(prompt)) {
      promptWritten = true;
      originalWriteToOutput(prompt);
      return;
    }

    if (value === '\n' || value === '\r\n') {
      originalWriteToOutput(value);
    }
  };

  try {
    return (await rl.question(prompt)).trim();
  } finally {
    mutableRl._writeToOutput = originalWriteToOutput;
  }
}

export async function promptForSecretInput(params: {
  prompt: string;
  missingMessage?: string;
  rl?: readline.Interface;
}): Promise<string> {
  const normalizedPrompt = normalizeSecretPrompt(params.prompt);
  ensureInteractiveTerminal(params.missingMessage);

  if (params.rl) {
    return await promptForSecretInputWithReadline(
      params.rl,
      normalizedPrompt,
      params.missingMessage,
    );
  }

  const ttyInput = process.stdin as NodeJS.ReadStream;
  // Readline can leave stdin listeners behind after earlier prompts. Switch to
  // a fresh controlling TTY so secret input stays hidden.
  if (shouldUseDedicatedSecretTty()) {
    const dedicatedTty = openDedicatedSecretTty();
    if (dedicatedTty) {
      try {
        return await readHiddenSecretFromTty(
          normalizedPrompt,
          dedicatedTty.input,
          dedicatedTty.output,
        );
      } finally {
        dedicatedTty.close();
      }
    }
  }

  if (typeof ttyInput.setRawMode !== 'function') {
    return await promptForSecretInputFallback(normalizedPrompt);
  }

  return await readHiddenSecretFromTty(
    normalizedPrompt,
    ttyInput,
    process.stdout,
  );
}
