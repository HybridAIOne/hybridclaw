import readline from 'node:readline/promises';

type MutableReadlineInterface = readline.Interface & {
  _writeToOutput?: (value: string) => void;
};

function ensureInteractiveTerminal(missingMessage?: string): void {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error(missingMessage || 'Interactive terminal required.');
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
  const wasPaused = ttyInput.isPaused();
  ttyInput.setRawMode(true);
  ttyInput.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      ttyInput.off('data', handleData);
      ttyInput.setRawMode(previousRawMode ?? false);
      if (wasPaused) {
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
): Promise<string> {
  const mutableRl = rl as MutableReadlineInterface;
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
  ensureInteractiveTerminal(params.missingMessage);

  if (params.rl) {
    return await promptForSecretInputWithReadline(params.rl, params.prompt);
  }

  const ttyInput = process.stdin as NodeJS.ReadStream;
  if (typeof ttyInput.setRawMode !== 'function') {
    return await promptForSecretInputFallback(params.prompt);
  }

  return await readHiddenSecretFromTty(params.prompt, ttyInput, process.stdout);
}
