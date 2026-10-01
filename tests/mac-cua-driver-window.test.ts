import { afterEach, expect, test, vi } from 'vitest';

type ToolCall = { name: string; arguments: Record<string, unknown> };

function mockCuaMcp(
  handler: (call: ToolCall) => Record<string, unknown>,
): ToolCall[] {
  const calls: ToolCall[] = [];
  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
      async connect(): Promise<void> {}
      async close(): Promise<void> {}
      async callTool(call: ToolCall) {
        calls.push(call);
        return { content: [], structuredContent: handler(call) };
      }
    },
  }));
  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    getDefaultEnvironment: () => ({}),
    StdioClientTransport: class {
      stderr = null;
      async close(): Promise<void> {}
    },
  }));
  return calls;
}

function safariRunning(running: boolean) {
  return {
    apps: [{ bundle_id: 'com.apple.Safari', pid: 42, running }],
  };
}

function windows(...ids: number[]) {
  return {
    windows: ids.map((id) => ({
      window_id: id,
      layer: 0,
      on_current_space: true,
      bounds: { width: 800, height: 600 },
    })),
  };
}

async function createDriver() {
  const { StdioMacCuaDriver } = await import(
    '../src/browser/mac-cua-driver.js'
  );
  return new StdioMacCuaDriver('cua-driver', ['mcp']);
}

async function startSession() {
  const driver = await createDriver();
  return await driver.startBrowserSession({
    bundleId: 'com.apple.Safari',
    backgroundSafe: true,
  });
}

afterEach(() => {
  vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
  vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js');
  vi.resetModules();
});

test('opens a dedicated window instead of adopting the operator window', async () => {
  let listed = 0;
  const calls = mockCuaMcp(({ name }) => {
    if (name === 'list_apps') return safariRunning(true);
    if (name === 'list_windows') {
      listed += 1;
      // The operator's chat window (7) stays; the new window (9) appears
      // after Cmd+N on the second poll.
      return listed < 3 ? windows(7) : windows(7, 9);
    }
    return {};
  });

  const session = await startSession();

  expect(session).toEqual({ sessionId: '42:9', windowId: 9 });
  expect(calls.find((call) => call.name === 'hotkey')?.arguments).toEqual({
    pid: 42,
    window_id: 7,
    keys: ['cmd', 'n'],
  });
  expect(calls.some((call) => call.name === 'launch_app')).toBe(false);
});

test('fails instead of falling back to an existing window when none opens', async () => {
  mockCuaMcp(({ name }) => {
    if (name === 'list_apps') return safariRunning(true);
    if (name === 'list_windows') return windows(7);
    return {};
  });
  const driver = await createDriver();
  vi.useFakeTimers();
  try {
    const started = driver.startBrowserSession({
      bundleId: 'com.apple.Safari',
      backgroundSafe: true,
    });
    const assertion = expect(started).rejects.toThrow(
      /refusing to control an existing browser window/,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  { label: 'not running', running: false, ids: [7] },
  { label: 'running without windows', running: true, ids: [] as number[] },
])('launches a new browser window when the browser is $label', async ({
  running,
  ids,
}) => {
  const calls = mockCuaMcp(({ name }) => {
    if (name === 'list_apps') return safariRunning(running);
    if (name === 'list_windows') return windows(...ids);
    if (name === 'launch_app') return { pid: 42, ...windows(11) };
    return {};
  });

  const session = await startSession();

  expect(session).toEqual({ sessionId: '42:11', windowId: 11 });
  expect(calls.find((call) => call.name === 'launch_app')?.arguments).toEqual({
    bundle_id: 'com.apple.Safari',
    urls: ['about:blank'],
  });
  expect(calls.some((call) => call.name === 'hotkey')).toBe(false);
});

// Safari with the operator's window 7 open; Cmd+N opens 100, 101, ...
function fakeSafari() {
  const open = new Set([7]);
  let nextWindowId = 100;
  const calls = mockCuaMcp(({ name, arguments: args }) => {
    if (name === 'list_apps') return safariRunning(true);
    if (name === 'list_windows') return windows(...open);
    if (name === 'hotkey' && String(args.keys) === 'cmd,n') {
      open.add(nextWindowId++);
    }
    return {};
  });
  return { calls, open };
}

test.each([
  { window: 'closed', closed: true, reopened: true, windowId: 101 },
  { window: 'still open', closed: false, reopened: false, windowId: 100 },
])('sends keys to a dedicated window when the session window is $window', async ({
  closed,
  reopened,
  windowId,
}) => {
  const { calls, open } = fakeSafari();
  const driver = await createDriver();
  const { sessionId } = await driver.startBrowserSession({
    bundleId: 'com.apple.Safari',
    backgroundSafe: true,
  });
  if (closed) open.delete(100);

  await expect(driver.ensureSessionWindow(sessionId)).resolves.toBe(reopened);
  await driver.pressKey(sessionId, 'return');

  expect(calls.at(-1)).toEqual({
    name: 'press_key',
    arguments: { pid: 42, window_id: windowId, key: 'return' },
  });
  // The operator's window only anchors Cmd+N; nothing else is sent to it.
  expect(
    calls
      .filter((call) => call.arguments.window_id === 7)
      .map((call) => [call.name, String(call.arguments.keys)]),
  ).toEqual(Array(reopened ? 2 : 1).fill(['hotkey', 'cmd,n']));
});

test('reads the page title from the session window', async () => {
  mockCuaMcp(({ name }) => {
    if (name === 'list_apps') return safariRunning(false);
    if (name === 'launch_app') return { pid: 42, ...windows(11) };
    if (name === 'list_windows') {
      return {
        windows: [
          { window_id: 7, title: 'Operator chat' },
          { window_id: 11, title: 'HybridAI' },
        ],
      };
    }
    return {};
  });

  const driver = await createDriver();
  const { sessionId } = await driver.startBrowserSession({
    bundleId: 'com.apple.Safari',
    backgroundSafe: true,
  });

  await expect(driver.getWindowTitle(sessionId)).resolves.toBe('HybridAI');
});
