import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: 'signal-cli 0.14.2\n',
    stderr: '',
    error: undefined,
  })),
}));

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn(
      (
        input: string,
        _options: { small?: boolean },
        callback: (rendered: string) => void,
      ) => callback(`qr:${input}`),
    ),
  },
}));

function createFakeSignalCliProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('Signal pairing', () => {
  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  test('starts signal-cli link and renders the pairing QR from the link URI', async () => {
    const child = createFakeSignalCliProcess();
    spawnMock.mockReturnValue(child);
    const { getSignalLinkState, startSignalLink } = await import(
      '../src/channels/signal/pairing.ts'
    );

    expect(
      startSignalLink({
        cliPath: '/usr/local/bin/signal-cli',
        deviceName: 'HybridClaw Test',
      }),
    ).toMatchObject({ status: 'starting' });

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/signal-cli',
      ['link', '-n', 'HybridClaw Test'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    child.stdout.emit(
      'data',
      'Open this link: sgnl://linkdevice?uuid=abc&pub_key=def',
    );

    expect(getSignalLinkState()).toMatchObject({
      status: 'qr',
      pairingUri: 'sgnl://linkdevice?uuid=abc&pub_key=def',
      pairingQrText: 'qr:sgnl://linkdevice?uuid=abc&pub_key=def',
      error: null,
    });
  });

  test('records spawn errors for the admin UI', async () => {
    const child = createFakeSignalCliProcess();
    spawnMock.mockReturnValue(child);
    const { getSignalLinkState, startSignalLink } = await import(
      '../src/channels/signal/pairing.ts'
    );

    startSignalLink();
    child.emit('error', new Error('signal-cli not found'));

    expect(getSignalLinkState()).toMatchObject({
      status: 'error',
      error: 'signal-cli not found',
    });
  });
});
