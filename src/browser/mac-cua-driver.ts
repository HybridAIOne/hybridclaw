/**
 * cua-driver MCP adapter — the only module that speaks the cua-driver stdio
 * protocol and holds the (pid, window_id) each mac-cua session controls.
 *
 * It opens a dedicated browser window per session and never adopts one the
 * operator already has open. cua-driver posts keys to the pid; window_id only
 * pre-focuses, so keys sent to a closed window land in whichever window has
 * focus. Callers confirm the window with ensureSessionWindow first.
 * NOT the policy layer: key-chord and payload guards, background-safe
 * checks, and audit live in mac-cua-provider.ts.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SecretRef } from '../security/secret-refs.js';
import { sleep } from '../utils/sleep.js';
import {
  firstEditableElementSelector,
  firstEditableElementTarget,
  firstElementIndex,
  normalizePositiveInteger,
  normalizeWindowId,
} from './mac-cua-window-state.js';
import type { ScreenshotOptions, WaitOptions } from './provider.js';

export type MacCuaScreenshotMode = 'som' | 'vision' | 'ax';

export interface MacCuaEnvironmentState {
  cursorX: number;
  cursorY: number;
  frontmostBundleId: string;
  activeSpaceId?: string | number | null;
}

export type MacCuaTarget =
  | { kind: 'ax'; elementIndex: number; windowId?: string | number }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'query'; query: string };

export interface MacCuaResolvedTarget {
  target: MacCuaTarget;
  pixelFallback?: {
    reason: string;
  };
}

export interface MacCuaScreenshotResult {
  dataBase64: string;
  mimeType?: string;
}

export interface MacCuaDriver {
  startBrowserSession(params: {
    bundleId: string;
    backgroundSafe: true;
  }): Promise<{ sessionId: string; windowId?: string | number }>;
  stopBrowserSession(sessionId: string): Promise<void>;
  keyChord(
    sessionId: string,
    params: { key: string; modifiers: string[] },
  ): Promise<void>;
  pressKey(sessionId: string, key: string): Promise<void>;
  typeTextChars(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void>;
  click(sessionId: string, target: MacCuaTarget): Promise<void>;
  setValue(
    sessionId: string,
    target: MacCuaTarget,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void>;
  scroll(
    sessionId: string,
    params: { target?: MacCuaTarget; deltaX: number; deltaY: number },
  ): Promise<void>;
  screenshot(
    sessionId: string,
    opts: ScreenshotOptions & { mode: MacCuaScreenshotMode },
  ): Promise<MacCuaScreenshotResult>;
  waitForElement(
    sessionId: string,
    target: MacCuaTarget,
    opts?: WaitOptions,
  ): Promise<void>;
  resolveTarget(
    sessionId: string,
    target: MacCuaTarget,
  ): Promise<MacCuaResolvedTarget>;
  getAddressBarValue(sessionId: string): Promise<string | null>;
  getCurrentUrl(sessionId: string): Promise<string | null>;
  detectTwoFactorWaypoint?(
    sessionId: string,
  ): Promise<{ detected: boolean; signals?: string[]; selectors?: string[] }>;
  fillTwoFactorInput?(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<boolean>;
  focusTwoFactorInput?(sessionId: string): Promise<boolean>;
  getEnvironmentState(): Promise<MacCuaEnvironmentState>;
  /**
   * Opens a new dedicated window when the session's window is gone and
   * returns true; the old page state is lost with it.
   */
  ensureSessionWindow(sessionId: string): Promise<boolean>;
  getWindowTitle(sessionId: string): Promise<string>;
}

type DriverSession = {
  bundleId: string;
  pid: number;
  windowId: number;
  lastTypedText?: string;
};

const DEFAULT_DRIVER_TIMEOUT_MS = 60_000;
const NEW_WINDOW_TIMEOUT_MS = 5_000;
const NEW_WINDOW_POLL_MS = 150;
const CUA_MCP_CLIENT_INFO = {
  name: 'hybridclaw-mac-cua',
  version: process.env.npm_package_version || '0.0.0',
};

function defaultDriverCommand(): { command: string; args: string[] } {
  const configured = process.env.HYBRIDAI_CUA_DRIVER_BIN?.trim();
  return {
    command: configured || 'cua-driver',
    args: ['mcp', '--no-daemon-relaunch'],
  };
}

export function resolveMacCuaDriverCommand(options?: {
  command?: string;
  args?: string[];
}): { command: string; args: string[] } {
  const fallback = defaultDriverCommand();
  return {
    command: options?.command || fallback.command,
    args:
      options?.args && options.args.length > 0 ? options.args : fallback.args,
  };
}

function scrollDirectionFromDelta(
  deltaX: number,
  deltaY: number,
): 'up' | 'down' | 'left' | 'right' {
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return deltaX < 0 ? 'left' : 'right';
  }
  return deltaY < 0 ? 'up' : 'down';
}

interface CuaMcpToolResult {
  data: unknown;
  images: string[];
  structuredContent: Record<string, unknown> | null;
  isError: boolean;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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

function normalizeMcpToolResult(result: CallToolResult): CuaMcpToolResult {
  const images: string[] = [];
  const textChunks: string[] = [];
  for (const part of result.content || []) {
    if (part.type === 'text') {
      textChunks.push(part.text || '');
    } else if (part.type === 'image' && part.data) {
      images.push(part.data);
    }
  }
  const text = textChunks.filter(Boolean).join('\n');
  let data: unknown = text;
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  const structured =
    result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent)
      ? (result.structuredContent as Record<string, unknown>)
      : null;
  return {
    data,
    images,
    structuredContent: structured,
    isError: result.isError === true,
  };
}

export class StdioMacCuaDriver implements MacCuaDriver {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, DriverSession>();

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly timeoutMs = DEFAULT_DRIVER_TIMEOUT_MS,
  ) {}

  async startBrowserSession(params: {
    bundleId: string;
    backgroundSafe: true;
  }): Promise<{ sessionId: string; windowId?: string | number }> {
    const { pid, windowId } = await this.openDedicatedWindow(params.bundleId);
    const sessionId = `${pid}:${windowId}`;
    this.sessions.set(sessionId, { bundleId: params.bundleId, pid, windowId });
    return {
      sessionId,
      windowId,
    };
  }

  async ensureSessionWindow(sessionId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    if (await this.findSessionWindow(session)) return false;
    // The sessionId stays the caller's handle; only its target moves.
    const { pid, windowId } = await this.openDedicatedWindow(session.bundleId);
    session.pid = pid;
    session.windowId = windowId;
    return true;
  }

  async getWindowTitle(sessionId: string): Promise<string> {
    const window = await this.findSessionWindow(this.requireSession(sessionId));
    return typeof window?.title === 'string' ? window.title : '';
  }

  async stopBrowserSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) {
      await this.closeMcpSession();
    }
  }

  async keyChord(
    sessionId: string,
    params: { key: string; modifiers: string[] },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('hotkey', {
      pid: session.pid,
      window_id: session.windowId,
      keys: [...params.modifiers, params.key],
    });
  }

  async pressKey(sessionId: string, key: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('press_key', {
      pid: session.pid,
      window_id: session.windowId,
      key,
    });
  }

  async typeTextChars(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void> {
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

  async click(sessionId: string, target: MacCuaTarget): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('click', {
      pid: session.pid,
      window_id: session.windowId,
      ...this.toDriverTarget(target),
    });
  }

  async setValue(
    sessionId: string,
    target: MacCuaTarget,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void> {
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

  async scroll(
    sessionId: string,
    params: { target?: MacCuaTarget; deltaX: number; deltaY: number },
  ): Promise<void> {
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

  async screenshot(
    sessionId: string,
    opts: ScreenshotOptions & { mode: MacCuaScreenshotMode },
  ): Promise<MacCuaScreenshotResult> {
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

  async waitForElement(
    sessionId: string,
    target: MacCuaTarget,
    opts?: WaitOptions,
  ): Promise<void> {
    await this.resolveTarget(sessionId, target);
    void opts;
  }

  async resolveTarget(
    sessionId: string,
    target: MacCuaTarget,
  ): Promise<MacCuaResolvedTarget> {
    const session = this.requireSession(sessionId);
    if (target.kind === 'point') return { target };
    if (target.kind === 'ax') return { target };
    const record = await this.callToolRecord('get_window_state', {
      pid: session.pid,
      window_id: session.windowId,
      query: target.query,
    });
    const elementIndex = firstElementIndex(record);
    if (elementIndex === null) return { target };
    return { target: { kind: 'ax', elementIndex, windowId: session.windowId } };
  }

  async getAddressBarValue(sessionId: string): Promise<string | null> {
    return this.requireSession(sessionId).lastTypedText || null;
  }

  async getCurrentUrl(sessionId: string): Promise<string | null> {
    const session = this.requireSession(sessionId);
    try {
      const record = await this.callToolRecord('page', {
        pid: session.pid,
        window_id: session.windowId,
        action: 'execute_javascript',
        javascript: '(() => window.location.href)()',
      });
      const value = record.result || record.value;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }

  async detectTwoFactorWaypoint(
    sessionId: string,
  ): Promise<{ detected: boolean; signals?: string[]; selectors?: string[] }> {
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

  private async findTwoFactorInputTarget(
    sessionId: string,
  ): Promise<MacCuaTarget | null> {
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

  async fillTwoFactorInput(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<boolean> {
    const target = await this.findTwoFactorInputTarget(sessionId);
    if (!target) return false;
    await this.setValue(sessionId, target, payload);
    return true;
  }

  async focusTwoFactorInput(sessionId: string): Promise<boolean> {
    const target = await this.findTwoFactorInputTarget(sessionId);
    if (!target) {
      return false;
    }
    await this.click(sessionId, target);
    return true;
  }

  async getEnvironmentState(): Promise<MacCuaEnvironmentState> {
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
          (app): app is Record<string, unknown> =>
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

  private requireSession(sessionId: string): DriverSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('mac-cua driver session is not active.');
    return session;
  }

  private async findSessionWindow(
    session: DriverSession,
  ): Promise<Record<string, unknown> | undefined> {
    return (await this.listWindowRecords(session.pid)).find(
      (entry) => normalizePositiveInteger(entry.window_id) === session.windowId,
    );
  }

  // Never adopt a window the operator already has open: it may hold the
  // HybridClaw chat itself or unrelated work. Open a dedicated one instead.
  private async openDedicatedWindow(
    bundleId: string,
  ): Promise<{ pid: number; windowId: number }> {
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

  private toDriverTarget(target: MacCuaTarget): {
    element_index?: number;
    x?: number;
    y?: number;
  } {
    if (target.kind === 'point') return { x: target.x, y: target.y };
    if (target.kind === 'ax') return { element_index: target.elementIndex };
    throw new Error('mac-cua query target was not resolved to AX or point.');
  }

  private async openWindowInRunningBrowser(
    bundleId: string,
  ): Promise<Record<string, unknown> | null> {
    const apps = await this.callToolRecord('list_apps', {});
    const app = Array.isArray(apps.apps)
      ? apps.apps.find(
          (entry): entry is Record<string, unknown> =>
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

  private async listWindowRecords(
    pid: number,
  ): Promise<Record<string, unknown>[]> {
    const windows = await this.callToolRecord('list_windows', {
      pid,
      on_screen_only: false,
    });
    return Array.isArray(windows.windows)
      ? windows.windows.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            !Array.isArray(entry),
        )
      : [];
  }

  private async listWindowIds(pid: number): Promise<Set<number>> {
    const ids = new Set<number>();
    for (const entry of await this.listWindowRecords(pid)) {
      const id = normalizePositiveInteger(entry.window_id);
      if (id !== null) ids.add(id);
    }
    return ids;
  }

  private async callToolRecord(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
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
    return payload as Record<string, unknown>;
  }

  private async callToolText(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.callTool(tool, args);
    return typeof result.data === 'string' ? result.data : '';
  }

  private async callTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CuaMcpToolResult> {
    await this.ensureMcpSession();
    if (!this.client) throw new Error('mac-cua MCP client is not connected.');
    const result = (await withTimeout(
      this.client.callTool(
        {
          name: tool,
          arguments: args,
        },
        CallToolResultSchema,
      ),
      this.timeoutMs,
      `mac-cua driver tool ${tool}`,
    )) as CallToolResult;
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

  private async ensureMcpSession(): Promise<void> {
    if (this.client) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = (async () => {
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
      this.client = client;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async closeMcpSession(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.startPromise = null;
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}
