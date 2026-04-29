import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import {
  getSignalPairingState,
  type SignalPairingState,
  setSignalPairingComplete,
  setSignalPairingError,
  setSignalPairingQr,
  setSignalPairingStarting,
} from './pairing-state.js';

const DEFAULT_SIGNAL_CLI_PATH = 'signal-cli';
const DEFAULT_SIGNAL_LINK_DEVICE_NAME = 'HybridClaw';
const SIGNAL_LINK_TIMEOUT_MS = 180_000;
const SIGNAL_LINK_URI_RE = /sgnl:\/\/linkdevice\?[^\s"'<>]+/i;
const OUTPUT_LIMIT = 8_000;

let activeLinkProcess: ChildProcess | null = null;
let activeTimeout: NodeJS.Timeout | null = null;
let capturedOutput = '';

function normalizeSignalCliPath(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) return DEFAULT_SIGNAL_CLI_PATH;
  if (normalized.includes('\0')) {
    throw new Error('Invalid signal-cli path.');
  }
  return normalized;
}

function normalizeDeviceName(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) return DEFAULT_SIGNAL_LINK_DEVICE_NAME;
  if (normalized.includes('\0')) {
    throw new Error('Invalid Signal device name.');
  }
  return normalized.slice(0, 80);
}

function renderPairingQrText(uri: string): string {
  let pairingQrText = '';
  qrcode.generate(uri, { small: true }, (rendered) => {
    pairingQrText = rendered.trimEnd();
  });
  return pairingQrText;
}

function appendOutput(chunk: Buffer | string): void {
  capturedOutput = `${capturedOutput}${String(chunk)}`.slice(-OUTPUT_LIMIT);
  const match = SIGNAL_LINK_URI_RE.exec(capturedOutput);
  if (!match) return;

  const pairingUri = match[0];
  setSignalPairingQr({
    pairingUri,
    pairingQrText: renderPairingQrText(pairingUri),
  });
}

function clearActiveTimeout(): void {
  if (!activeTimeout) return;
  clearTimeout(activeTimeout);
  activeTimeout = null;
}

function clearActiveProcess(process: ChildProcess): void {
  if (activeLinkProcess !== process) return;
  activeLinkProcess = null;
  clearActiveTimeout();
}

export function getSignalLinkState(): SignalPairingState {
  return getSignalPairingState();
}

export interface SignalCliAvailability {
  available: boolean;
  path: string;
  version: string | null;
  error: string | null;
}

export function getSignalCliAvailability(
  cliPath?: string,
): SignalCliAvailability {
  const resolvedPath = normalizeSignalCliPath(cliPath);
  const result = spawnSync(resolvedPath, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error) {
    return {
      available: false,
      path: resolvedPath,
      version: null,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      available: false,
      path: resolvedPath,
      version: null,
      error: output || `signal-cli exited with code ${result.status}`,
    };
  }
  return {
    available: true,
    path: resolvedPath,
    version: output || null,
    error: null,
  };
}

export function startSignalLink(params?: {
  cliPath?: string;
  deviceName?: string;
}): SignalPairingState {
  if (activeLinkProcess && !activeLinkProcess.killed) {
    return getSignalPairingState();
  }

  const cliPath = normalizeSignalCliPath(params?.cliPath);
  const availability = getSignalCliAvailability(cliPath);
  if (!availability.available) {
    throw new Error(availability.error || 'signal-cli is not available.');
  }

  const deviceName = normalizeDeviceName(params?.deviceName);
  capturedOutput = '';
  setSignalPairingStarting();

  const child = spawn(cliPath, ['link', '-n', deviceName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeLinkProcess = child;

  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.on('error', (error) => {
    clearActiveProcess(child);
    setSignalPairingError(error.message);
  });
  child.on('close', (code) => {
    clearActiveProcess(child);
    if (code === 0) {
      setSignalPairingComplete();
      return;
    }
    if (getSignalPairingState().status === 'error') return;
    setSignalPairingError(
      capturedOutput.trim() ||
        `signal-cli link exited with code ${code ?? 'unknown'}.`,
    );
  });

  activeTimeout = setTimeout(() => {
    if (activeLinkProcess !== child) return;
    child.kill('SIGTERM');
    setSignalPairingError('Signal linked-device QR expired. Start a new link.');
  }, SIGNAL_LINK_TIMEOUT_MS);
  activeTimeout.unref();

  return getSignalPairingState();
}
