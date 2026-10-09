/**
 * The upstream Cua Driver (`cua-driver mcp`) over MCP stdio. Each browser
 * session owns one window it opened itself, keyed `<pid>:<windowId>`, so the
 * agent never drives a window the operator already had open. The MCP SDK
 * comes from the gateway through the provider host.
 */
import {
  findMacCuaAddressBarUrl,
  findMacCuaHistoryButton,
  firstEditableElementSelector,
  firstEditableElementTarget,
  normalizePositiveInteger,
  normalizeWindowId,
  renderMacCuaPageSnapshot,
  resolveMacCuaQueryElementIndex,
  windowStateTree,
} from './window-state.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_DRIVER_TIMEOUT_MS = 60_000;
const NEW_WINDOW_TIMEOUT_MS = 5_000;
const NEW_WINDOW_POLL_MS = 150;
// Like Playwright's auto-wait: navigate returns once Return is pressed, so a
// click right after it can run before the page has its links.
const QUERY_WAIT_MS = 5_000;
const QUERY_POLL_MS = 500;
const CUA_MCP_CLIENT_INFO = {
  name: 'hybridclaw-mac-cua',
  version: process.env.npm_package_version || '0.0.0',
};

function defaultDriverCommand() {
  const configured = process.env.HYBRIDAI_CUA_DRIVER_BIN?.trim();
  return {
    command: configured || 'cua-driver',
    args: ['mcp', '--no-daemon-relaunch'],
  };
}

export function resolveMacCuaDriverCommand(options) {
  const fallback = defaultDriverCommand();
  return {
    command: options?.command || fallback.command,
    args:
      options?.args && options.args.length > 0 ? options.args : fallback.args,
  };
}

function scrollDirectionFromDelta(deltaX, deltaY) {
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return deltaX < 0 ? 'left' : 'right';
  }
  return deltaY < 0 ? 'up' : 'down';
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeMcpToolResult(result) {
  const images = [];
  const textChunks = [];
  for (const part of result.content || []) {
    if (part.type === 'text') {
      textChunks.push(part.text || '');
    } else if (part.type === 'image' && part.data) {
      images.push(part.data);
    }
  }
  const text = textChunks.filter(Boolean).join('\n');
  let data = text;
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const structured =
    result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : null;
  return {
    data,
    images,
    structuredContent: structured,
    isError: result.isError === true,
  };
}

export class StdioMacCuaDriver {
  client = null;
  transport = null;
  callToolResultSchema = null;
  startPromise = null;
  sessions = new Map();

  constructor(command, args, loadMcp, timeoutMs = DEFAULT_DRIVER_TIMEOUT_MS) {
    this.command = command;
    this.args = args;
    this.loadMcp = loadMcp;
    this.timeoutMs = timeoutMs;
  }

  async startBrowserSession(params) {
    const { pid, windowId } = await this.openDedicatedWindow(params.bundleId);
    const sessionId = `${pid}:${windowId}`;
    this.sessions.set(sessionId, { bundleId: params.bundleId, pid, windowId });
    return {
      sessionId,
      windowId,
    };
  }

  async ensureSessionWindow(sessionId) {
    const session = this.requireSession(sessionId);
    if (await this.findSessionWindow(session)) return false;
    // The sessionId stays the caller's handle; only its target moves.
    const { pid, windowId } = await this.openDedicatedWindow(session.bundleId);
    session.pid = pid;
    session.windowId = windowId;
    return true;
  }

  async getWindowTitle(sessionId) {
    const window = await this.findSessionWindow(this.requireSession(sessionId));
    return typeof window?.title === 'string' ? window.title : '';
  }

  async stopBrowserSession(sessionId) {
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) {
      await this.closeMcpSession();
    }
  }

  async keyChord(sessionId, params) {
    const session = this.requireSession(sessionId);
    await this.callTool('hotkey', {
      pid: session.pid,
      window_id: session.windowId,
      keys: [...params.modifiers, params.key],
    });
  }

  async pressKey(sessionId, key) {
    const session = this.requireSession(sessionId);
    await this.callTool('press_key', {
      pid: session.pid,
      window_id: session.windowId,
      key,
    });
  }

  // cua-driver has no bracket keys, so Cmd+[ cannot go back. Pressing the
  // toolbar button also acts on this window only, where keys go to whichever
  // window has focus.
  async pressHistoryButton(sessionId, direction) {
    const session = this.requireSession(sessionId);
    // Reading the tree also refreshes cua-driver's element indices.
    const button = findMacCuaHistoryButton(
      await this.readWindowTree(sessionId),
      direction,
    );
    if (!button) {
      throw new Error(`mac-cua cannot find the browser's ${direction} button.`);
    }
    if (button.disabled) {
      throw new Error(`There is no page to go ${direction} to.`);
    }
    await this.callTool('click', {
      pid: session.pid,
      window_id: session.windowId,
      element_index: button.index,
    });
  }

  async typeTextChars(sessionId, payload) {
    const session = this.requireSession(sessionId);
    if ('secretRef' in payload) {
      throw new Error(
        'mac-cua MCP driver cannot resolve SecretRef payloads directly.',
      );
    }
    session.lastTypedText = payload.text;
    const args = {
      pid: session.pid,
      window_id: session.windowId,
      text: payload.text,
    };
    try {
      await this.callTool('type_text_chars', args);
    } catch (error) {
      if (!String(error).includes('Unknown tool')) throw error;
      await this.callTool('type_text', args);
    }
  }

  async click(sessionId, target) {
    const session = this.requireSession(sessionId);
    await this.callTool('click', {
      pid: session.pid,
      window_id: session.windowId,
      ...this.toDriverTarget(target),
    });
  }

  async setValue(sessionId, target, payload) {
    const session = this.requireSession(sessionId);
    if ('secretRef' in payload) {
      throw new Error(
        'mac-cua MCP driver cannot resolve SecretRef payloads directly.',
      );
    }
    await this.callTool('set_value', {
      pid: session.pid,
      window_id: session.windowId,
      ...this.toDriverTarget(target),
      value: payload.text,
    });
  }

  async scroll(sessionId, params) {
    const session = this.requireSession(sessionId);
    await this.callTool('scroll', {
      pid: session.pid,
      window_id: session.windowId,
      ...(params.target ? this.toDriverTarget(params.target) : {}),
      direction: scrollDirectionFromDelta(params.deltaX, params.deltaY),
      by: 'page',
      amount: 1,
    });
  }

  async screenshot(sessionId, opts) {
    const session = this.requireSession(sessionId);
    const result =
      opts.mode === 'ax'
        ? await this.callTool('get_window_state', {
            pid: session.pid,
            window_id: session.windowId,
          })
        : await this.callTool('screenshot', {
            window_id: session.windowId,
            format: opts.type || 'png',
            ...(opts.type === 'jpeg' && opts.quality
              ? { quality: opts.quality }
              : {}),
          });
    const dataBase64 = result.images[0];
    if (!dataBase64) {
      const text =
        typeof result.data === 'string' ? result.data : JSON.stringify(result);
      throw new Error(
        text
          ? `mac-cua driver screenshot response did not include image bytes: ${text}`
          : 'mac-cua driver screenshot response did not include image bytes.',
      );
    }
    return {
      dataBase64,
      mimeType: opts.type === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  }

  async waitForElement(sessionId, target, opts) {
    await this.resolveTarget(sessionId, target);
    void opts;
  }

  async resolveTarget(sessionId, target, purpose = 'click') {
    const session = this.requireSession(sessionId);
    if (target.kind === 'point') return { target };
    if (target.kind === 'ax') return { target };
    const deadline = Date.now() + QUERY_WAIT_MS;
    for (;;) {
      const record = await this.callToolRecord('get_window_state', {
        pid: session.pid,
        window_id: session.windowId,
        query: target.query,
      });
      const elementIndex = resolveMacCuaQueryElementIndex(
        windowStateTree(record),
        target.query,
        purpose,
      );
      if (elementIndex !== null) {
        return {
          target: { kind: 'ax', elementIndex, windowId: session.windowId },
        };
      }
      if (Date.now() >= deadline) return { target };
      await sleep(QUERY_POLL_MS);
    }
  }

  async readPage(sessionId, opts) {
    const tree = await this.readWindowTree(sessionId);
    return {
      ...renderMacCuaPageSnapshot(tree, opts),
      url: findMacCuaAddressBarUrl(tree),
    };
  }

  async getAddressBarValue(sessionId) {
    return this.requireSession(sessionId).lastTypedText || null;
  }

  async getCurrentUrl(sessionId) {
    const session = this.requireSession(sessionId);
    if (!session.pageScriptBlocked) {
      try {
        const record = await this.callToolRecord('page', {
          pid: session.pid,
          window_id: session.windowId,
          action: 'execute_javascript',
          javascript: '(() => window.location.href)()',
        });
        const value = record.result || record.value;
        if (typeof value === 'string' && value.trim()) return value.trim();
      } catch {
        // Safari refuses page JavaScript unless the operator enabled "Allow
        // JavaScript from Apple Events"; that does not change mid-session.
        session.pageScriptBlocked = true;
      }
    }
    try {
      return findMacCuaAddressBarUrl(await this.readWindowTree(sessionId));
    } catch {
      return null;
    }
  }

  async readWindowTree(sessionId) {
    const session = this.requireSession(sessionId);
    return windowStateTree(
      await this.callToolRecord('get_window_state', {
        pid: session.pid,
        window_id: session.windowId,
      }),
    );
  }

  async detectTwoFactorWaypoint(sessionId) {
    const session = this.requireSession(sessionId);
    const record = await this.callToolRecord('get_window_state', {
      pid: session.pid,
      window_id: session.windowId,
      query: 'verification code',
    });
    const text = JSON.stringify(record).toLowerCase();
    const detected =
      text.includes('verification code') ||
      text.includes('two-factor') ||
      text.includes('2fa') ||
      text.includes('one-time');
    if (!detected) return { detected: false };
    const selector = firstEditableElementSelector(record, session.windowId);
    return {
      detected: true,
      signals: ['ax_two_factor_text'],
      ...(selector ? { selectors: [selector] } : {}),
    };
  }

  async findTwoFactorInputTarget(sessionId) {
    const session = this.requireSession(sessionId);
    for (const query of [
      'one-time-code',
      'otp',
      'totp',
      'verification code',
      'two-factor',
      'code',
      '',
    ]) {
      const record = await this.callToolRecord('get_window_state', {
        pid: session.pid,
        window_id: session.windowId,
        ...(query ? { query } : {}),
      });
      const target = firstEditableElementTarget(record, session.windowId);
      if (!target) continue;
      return target;
    }
    return null;
  }

  async fillTwoFactorInput(sessionId, payload) {
    const target = await this.findTwoFactorInputTarget(sessionId);
    if (!target) return false;
    await this.setValue(sessionId, target, payload);
    return true;
  }

  async focusTwoFactorInput(sessionId) {
    const target = await this.findTwoFactorInputTarget(sessionId);
    if (!target) {
      return false;
    }
    await this.click(sessionId, target);
    return true;
  }

  async getEnvironmentState() {
    const [cursorText, apps, windows] = await Promise.all([
      this.callToolText('get_cursor_position', {}),
      this.callToolRecord('list_apps', {}),
      this.callToolRecord('list_windows', {}),
    ]);
    const cursor = cursorText.match(
      /\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/u,
    );
    const activeApp = Array.isArray(apps.apps)
      ? apps.apps.find(
          (app) =>
            Boolean(app) &&
            typeof app === 'object' &&
            !Array.isArray(app) &&
            app.active === true,
        )
      : null;
    return {
      cursorX: cursor?.[1] ? Number(cursor[1]) : 0,
      cursorY: cursor?.[2] ? Number(cursor[2]) : 0,
      frontmostBundleId:
        typeof activeApp?.bundle_id === 'string' ? activeApp.bundle_id : '',
      activeSpaceId:
        typeof windows.current_space_id === 'number'
          ? windows.current_space_id
          : null,
    };
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('mac-cua driver session is not active.');
    return session;
  }

  async findSessionWindow(session) {
    return (await this.listWindowRecords(session.pid)).find(
      (entry) => normalizePositiveInteger(entry.window_id) === session.windowId,
    );
  }

  // Never adopt a window the operator already has open: it may hold the
  // HybridClaw chat itself or unrelated work. Open a dedicated one instead.
  async openDedicatedWindow(bundleId) {
    const record =
      (await this.openWindowInRunningBrowser(bundleId)) ||
      (await this.callToolRecord('launch_app', {
        bundle_id: bundleId,
        urls: ['about:blank'],
      }));
    const pid = normalizePositiveInteger(record.pid);
    const windowId =
      normalizePositiveInteger(record.window_id) ||
      normalizeWindowId(record.windows);
    if (pid === null || windowId === null) {
      throw new Error(
        'mac-cua driver launch_app response did not include pid and window_id.',
      );
    }
    return { pid, windowId };
  }

  toDriverTarget(target) {
    if (target.kind === 'point') return { x: target.x, y: target.y };
    if (target.kind === 'ax') return { element_index: target.elementIndex };
    throw new Error(
      `No element on the page matches "${target.query}". Target it by its visible text or label (text: "Dashboard") or by a ref from browser_snapshot (ref: "@e23"); CSS and Playwright selectors do not work with mac-cua.`,
    );
  }

  async openWindowInRunningBrowser(bundleId) {
    const apps = await this.callToolRecord('list_apps', {});
    const app = Array.isArray(apps.apps)
      ? apps.apps.find(
          (entry) =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            entry.bundle_id === bundleId &&
            entry.running === true,
        )
      : null;
    const pid = normalizePositiveInteger(app?.pid);
    if (pid === null) return null;
    const before = await this.listWindowIds(pid);
    const anchorWindowId = before.values().next().value;
    // A running browser without windows gets one from launch_app's URL open.
    if (anchorWindowId === undefined) return null;
    // Passing an existing window_id lets the menu key equivalent reach the
    // backgrounded app; Cmd+N itself opens a new window without touching it.
    await this.callTool('hotkey', {
      pid,
      window_id: anchorWindowId,
      keys: ['cmd', 'n'],
    });
    const deadline = Date.now() + NEW_WINDOW_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(NEW_WINDOW_POLL_MS);
      const after = await this.listWindowRecords(pid);
      const fresh = after.filter((entry) => {
        const id = normalizePositiveInteger(entry.window_id);
        return id !== null && !before.has(id);
      });
      const windowId = normalizeWindowId(fresh);
      if (windowId !== null) return { pid, window_id: windowId };
    }
    throw new Error(
      `mac-cua driver could not open a dedicated ${bundleId} window; refusing to control an existing browser window.`,
    );
  }

  async listWindowRecords(pid) {
    const windows = await this.callToolRecord('list_windows', {
      pid,
      on_screen_only: false,
    });
    return Array.isArray(windows.windows)
      ? windows.windows.filter(
          (entry) =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            !Array.isArray(entry),
        )
      : [];
  }

  async listWindowIds(pid) {
    const ids = new Set();
    for (const entry of await this.listWindowRecords(pid)) {
      const id = normalizePositiveInteger(entry.window_id);
      if (id !== null) ids.add(id);
    }
    return ids;
  }

  async callToolRecord(tool, args) {
    const result = await this.callTool(tool, args);
    const payload =
      result.structuredContent ||
      (result.data &&
      typeof result.data === 'object' &&
      !Array.isArray(result.data)
        ? result.data
        : null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(
        `mac-cua driver tool ${tool} returned non-object output.`,
      );
    }
    return payload;
  }

  async callToolText(tool, args) {
    const result = await this.callTool(tool, args);
    return typeof result.data === 'string' ? result.data : '';
  }

  async callTool(tool, args) {
    await this.ensureMcpSession();
    if (!this.client || !this.callToolResultSchema) {
      throw new Error('mac-cua MCP client is not connected.');
    }
    const result = await withTimeout(
      this.client.callTool(
        {
          name: tool,
          arguments: args,
        },
        this.callToolResultSchema,
      ),
      this.timeoutMs,
      `mac-cua driver tool ${tool}`,
    );
    const normalized = normalizeMcpToolResult(result);
    if (normalized.isError) {
      const message =
        typeof normalized.data === 'string'
          ? normalized.data
          : JSON.stringify(
              normalized.data || normalized.structuredContent || {},
            );
      throw new Error(
        `mac-cua driver tool ${tool} failed${message ? `: ${message}` : ''}`,
      );
    }
    return normalized;
  }

  async ensureMcpSession() {
    if (this.client) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = (async () => {
      const {
        Client,
        getDefaultEnvironment,
        StdioClientTransport,
        CallToolResultSchema,
      } = await this.loadMcp();
      const transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        env: getDefaultEnvironment(),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        process.stderr.write(`[mac-cua] ${String(chunk)}`);
      });
      const client = new Client(CUA_MCP_CLIENT_INFO, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        this.timeoutMs,
        'mac-cua driver MCP connect',
      );
      this.transport = transport;
      this.callToolResultSchema = CallToolResultSchema;
      this.client = client;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async closeMcpSession() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.startPromise = null;
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}
