import fs from 'node:fs';

import { getFullAriaTree } from './aria-snapshot.js';
import { launchBrowserWithCdp } from './browser-launcher.js';
import { discoverCdpWsUrl } from './cdp-discovery.js';
import { CdpTransport } from './cdp-transport.js';
import { chooseChromiumBrowser } from './default-browser.js';
import {
  type ChromeExtensionRelayServer,
  ensureChromeExtensionRelayServer,
} from './extension-relay.js';
import {
  buildRoleSnapshotFromAriaSnapshot,
  resolveRoleRef,
} from './ref-system.js';
import { captureNormalizedScreenshot } from './screenshot.js';
import { validateNavigationUrl, validateRedirectTarget } from './ssrf-guard.js';
import type {
  BrowserCandidate,
  BrowserConnectionMode,
  BrowserConsoleMessage,
  BrowserExecutionMode,
  BrowserNetworkRequest,
  BrowserScreenshotResult,
  BrowserTab,
  FormattedAriaSnapshot,
  RoleRefMap,
} from './types.js';

const BOT_DETECTION_PATTERNS = [
  'access denied',
  'blocked',
  'bot detected',
  'captcha',
  'cloudflare',
  'checking your browser',
  'just a moment',
  'verification required',
];

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const MAX_SESSIONS = 5;
const MAX_TABS = 5;
const DEFAULT_CDP_PORTS = [9222, 9223, 9333];
const START_FAILURE_COOLDOWN_MS = 20 * 1000;
const EXTRACT_IMAGES_SCRIPT = `(() => {
  const images = Array.from(document.images || []);
  return images
    .map((img) => ({
      src: String(img.currentSrc || img.src || ''),
      alt: String(img.alt || ''),
      width: Number(img.naturalWidth || img.width || 0),
      height: Number(img.naturalHeight || img.height || 0),
    }))
    .filter((img) => img.src && !img.src.startsWith('data:'));
})()`;

type BrowserTransport = Pick<
  CdpTransport,
  'send' | 'onEvent' | 'close' | 'waitForEvent'
>;

type InternalSession = {
  sessionId: string;
  executionMode: BrowserExecutionMode;
  mode: BrowserConnectionMode;
  browser: BrowserCandidate;
  transport: BrowserTransport;
  launchedProcess?: import('node:child_process').ChildProcess | null;
  relay?: ChromeExtensionRelayServer;
  currentTargetId: string;
  cdpSessionId: string;
  port?: number;
  createdAt: number;
  lastActivityAt: number;
  refMap: RoleRefMap;
  lastSnapshotText: string;
  consoleMessages: BrowserConsoleMessage[];
  networkRequests: BrowserNetworkRequest[];
  networkRequestMap: Map<string, BrowserNetworkRequest>;
};

type StartFailure = {
  message: string;
  occurredAt: number;
};

type PageInfo = {
  url: string;
  title: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logBrowserSession(
  sessionId: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const suffix =
    details && Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : '';
  console.error(
    `[browser-session] session=${normalizeSessionId(sessionId)} ${message}${suffix}`,
  );
}

function normalizeSessionId(rawSessionId: string): string {
  const normalized = String(rawSessionId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  return normalized || 'default';
}

function readExecutionMode(): BrowserExecutionMode {
  const explicit = String(process.env.HYBRIDCLAW_AGENT_EXECUTION_MODE || '')
    .trim()
    .toLowerCase();
  if (explicit === 'host' || explicit === 'container') return explicit;
  return 'unknown';
}

function readConfiguredPorts(): number[] {
  const explicit = String(
    process.env.BROWSER_CDP_PORTS || process.env.BROWSER_CDP_PORT || '',
  )
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isFinite(port) && port > 0 && port < 65536);
  return Array.from(new Set([...explicit, ...DEFAULT_CDP_PORTS]));
}

function shouldUseExtensionRelay(): boolean {
  const raw = String(
    process.env.BROWSER_ENABLE_EXTENSION_RELAY ||
      process.env.BROWSER_EXTENSION_RELAY ||
      '',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function readExtensionRelayWaitMs(): number {
  const raw = Number.parseInt(
    String(process.env.BROWSER_EXTENSION_RELAY_WAIT_MS || '4000'),
    10,
  );
  return Number.isFinite(raw) ? Math.max(1_000, Math.min(raw, 30_000)) : 4_000;
}

function renderRemoteObject(remoteObject: unknown): string {
  if (!remoteObject || typeof remoteObject !== 'object') return '';
  const record = remoteObject as Record<string, unknown>;
  if (typeof record.value === 'string') return record.value;
  if (
    typeof record.value === 'number' ||
    typeof record.value === 'boolean' ||
    record.value === null
  ) {
    return String(record.value);
  }
  if (typeof record.description === 'string') return record.description;
  return '';
}

function parseBotDetectionWarning(title: string): string | undefined {
  const lower = title.toLowerCase();
  const matched = BOT_DETECTION_PATTERNS.find((pattern) =>
    lower.includes(pattern),
  );
  return matched
    ? `Possible anti-bot or verification page detected (${matched}).`
    : undefined;
}

async function tryDiscoverDirectConnection(): Promise<{
  wsUrl: string;
  port?: number;
} | null> {
  const explicitWsUrl = String(process.env.BROWSER_CDP_URL || '').trim();
  if (explicitWsUrl) return { wsUrl: explicitWsUrl };

  for (const port of readConfiguredPorts()) {
    try {
      const wsUrl = await discoverCdpWsUrl(port);
      return { wsUrl, port };
    } catch {
      // Keep probing.
    }
  }
  return null;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly recentStartFailures = new Map<string, StartFailure>();

  constructor() {
    const timer = setInterval(() => {
      void this.cleanupIdleSessions();
    }, WATCHDOG_INTERVAL_MS);
    timer.unref();

    const cleanup = () => {
      void this.closeAll();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }

  async start(options: {
    sessionId: string;
    headed?: boolean;
    preferredBrowser?: 'default' | 'chrome' | 'edge' | 'chromium' | 'safari';
  }): Promise<{
    mode: BrowserConnectionMode;
    browser: BrowserCandidate;
    executionMode: BrowserExecutionMode;
    port?: number;
    warning?: string;
    currentTab: BrowserTab;
  }> {
    const sessionId = normalizeSessionId(options.sessionId);
    logBrowserSession(sessionId, 'start requested', {
      preferredBrowser: options.preferredBrowser || 'default',
      headed: options.headed !== false,
      executionMode: readExecutionMode(),
    });
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touch(existing);
      logBrowserSession(sessionId, 'reusing existing session', {
        mode: existing.mode,
        browser: existing.browser.channel,
        targetId: existing.currentTargetId,
      });
      return {
        mode: existing.mode,
        browser: existing.browser,
        executionMode: existing.executionMode,
        port: existing.port,
        currentTab: await this.getCurrentTab(existing),
      };
    }
    const recentFailure = this.recentStartFailures.get(sessionId);
    if (
      recentFailure &&
      Date.now() - recentFailure.occurredAt < START_FAILURE_COOLDOWN_MS
    ) {
      logBrowserSession(sessionId, 'reusing recent start failure', {
        ageMs: Date.now() - recentFailure.occurredAt,
        error: recentFailure.message,
      });
      throw new Error(recentFailure.message);
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Browser session limit reached (${MAX_SESSIONS})`);
    }

    const executionMode = readExecutionMode();
    let mode: BrowserConnectionMode = 'direct';
    let port: number | undefined;
    let launchedProcess:
      | import('node:child_process').ChildProcess
      | null
      | undefined;
    let relay: ChromeExtensionRelayServer | undefined;
    let browser: BrowserCandidate | null = null;
    let transport: BrowserTransport | null = null;

    try {
      const direct = await tryDiscoverDirectConnection();
      if (direct) {
        logBrowserSession(sessionId, 'found direct CDP endpoint', {
          port: direct.port,
        });
        port = direct.port;
        browser = {
          channel: 'unknown',
          engine: 'chromium',
          name: 'Existing Chromium browser',
          executablePath: null,
          userDataDir: null,
          source: 'explicit',
        };
        const directTransport = new CdpTransport(direct.wsUrl);
        await directTransport.connect();
        transport = directTransport;
      } else {
        let connectedViaRelay = false;
        if (shouldUseExtensionRelay()) {
          logBrowserSession(sessionId, 'waiting for extension relay');
          relay = await ensureChromeExtensionRelayServer();
          try {
            await relay.waitForClient(readExtensionRelayWaitMs());
            mode = 'extension-relay';
            browser = chooseChromiumBrowser(options.preferredBrowser) || {
              channel: 'unknown',
              engine: 'chromium',
              name: 'Chromium browser via extension relay',
              executablePath: null,
              userDataDir: null,
              source: 'explicit',
            };
            transport = relay;
            connectedViaRelay = true;
            logBrowserSession(sessionId, 'extension relay connected', {
              browser: browser.channel,
            });
          } catch (error) {
            await relay.close().catch(() => undefined);
            relay = undefined;
            logBrowserSession(sessionId, 'extension relay unavailable', {
              error: error instanceof Error ? error.message : String(error),
            });
            if (executionMode !== 'host') {
              throw new Error(
                error instanceof Error
                  ? `${error.message}. No direct CDP endpoint was available and host-mode launching is not possible from container mode.`
                  : 'Extension relay did not connect and no direct CDP endpoint was available.',
              );
            }
          }
        }

        if (!connectedViaRelay) {
          logBrowserSession(sessionId, 'launching browser for CDP attach', {
            preferredBrowser: options.preferredBrowser || 'default',
          });
          const launched = await launchBrowserWithCdp({
            executionMode,
            headed: options.headed,
            preferredBrowser: options.preferredBrowser,
          });
          port = launched.port;
          mode = launched.mode;
          browser = launched.browser;
          launchedProcess = launched.process;
          const launchedTransport = new CdpTransport(launched.wsUrl);
          await launchedTransport.connect();
          transport = launchedTransport;
        }
      }

      if (!browser || !transport) {
        throw new Error('Failed to initialize a browser transport');
      }

      const target = await this.pickInitialTarget(transport);
      const attachResult = await this.attachToTarget(transport, target.id);
      logBrowserSession(sessionId, 'attached to browser target', {
        mode,
        browser: browser.channel,
        port,
        targetId: target.id,
        url: target.url,
      });

      const session: InternalSession = {
        sessionId,
        executionMode,
        mode,
        browser,
        transport,
        launchedProcess,
        relay,
        currentTargetId: target.id,
        cdpSessionId: attachResult,
        port,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        refMap: {},
        lastSnapshotText: '',
        consoleMessages: [],
        networkRequests: [],
        networkRequestMap: new Map(),
      };

      transport.onEvent((event) => this.handleEvent(session, event));
      await this.enableDomains(session);
      this.sessions.set(sessionId, session);
      this.recentStartFailures.delete(sessionId);
      logBrowserSession(sessionId, 'browser session started', {
        mode,
        browser: browser.channel,
        targetId: target.id,
      });

      return {
        mode,
        browser,
        executionMode,
        port,
        warning: browser.warning,
        currentTab: target,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown browser start failure');
      logBrowserSession(sessionId, 'browser session start failed', {
        error: message,
        mode,
        browser: browser?.channel,
        port,
      });
      this.recentStartFailures.set(sessionId, {
        message,
        occurredAt: Date.now(),
      });
      if (relay) {
        await relay.close().catch(() => undefined);
      }
      if (transport) {
        await transport.close().catch(() => undefined);
      }
      if (launchedProcess && launchedProcess.exitCode === null) {
        try {
          launchedProcess.kill('SIGTERM');
        } catch {
          // Best effort cleanup.
        }
      }
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    const session = this.sessions.get(normalized);
    this.recentStartFailures.delete(normalized);
    if (!session) return;
    logBrowserSession(normalized, 'stopping browser session', {
      mode: session.mode,
      browser: session.browser.channel,
      targetId: session.currentTargetId,
    });
    this.sessions.delete(normalized);
    try {
      await session.transport.close();
    } catch {
      // Best effort cleanup.
    }
    if (session.relay) {
      await session.relay.close().catch(() => undefined);
    }
    if (session.launchedProcess && session.launchedProcess.exitCode === null) {
      try {
        session.launchedProcess.kill('SIGTERM');
      } catch {
        // Best effort cleanup.
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.stop(sessionId);
    }
  }

  async navigate(
    sessionId: string,
    rawUrl: unknown,
  ): Promise<PageInfo & { snapshot: FormattedAriaSnapshot; warning?: string }> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const parsedUrl = await validateNavigationUrl(rawUrl);
    logBrowserSession(sessionId, 'navigating', {
      url: parsedUrl.toString(),
      targetId: session.currentTargetId,
    });
    const response = await session.transport.send<{
      frameId?: string;
      errorText?: string;
    }>(
      'Page.navigate',
      { url: parsedUrl.toString() },
      { sessionId: session.cdpSessionId, timeoutMs: 60_000 },
    );
    if (response.errorText) throw new Error(response.errorText);

    await this.waitForDocumentReady(session);
    const pageInfo = await this.getPageInfo(session);
    logBrowserSession(sessionId, 'navigation loaded', {
      url: pageInfo.url,
      title: pageInfo.title,
    });
    await validateRedirectTarget(pageInfo.url);
    const snapshot = await this.snapshot(sessionId, {
      compact: true,
    });
    logBrowserSession(sessionId, 'navigation snapshot captured', {
      refs: Object.keys(snapshot.refMap).length,
      interactiveRefs: snapshot.interactiveCount,
    });
    return {
      ...pageInfo,
      snapshot,
      warning: parseBotDetectionWarning(pageInfo.title),
    };
  }

  async snapshot(
    sessionId: string,
    options: { compact?: boolean } = {},
  ): Promise<FormattedAriaSnapshot> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const ariaNodes = await getFullAriaTree(
      session.transport,
      session.cdpSessionId,
    );
    const snapshot = buildRoleSnapshotFromAriaSnapshot(ariaNodes, {
      compact: options.compact,
    });
    session.refMap = snapshot.refMap;
    session.lastSnapshotText = snapshot.text;
    return snapshot;
  }

  async click(sessionId: string, ref: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const node = await resolveRoleRef(
      session.transport,
      session.cdpSessionId,
      session.refMap,
      ref,
    );
    await session.transport.send(
      'Runtime.callFunctionOn',
      {
        objectId: node.objectId,
        functionDeclaration:
          'function () { this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }',
      },
      { sessionId: session.cdpSessionId },
    );
    const quads = await session.transport.send<{
      quads?: number[][];
    }>(
      'DOM.getContentQuads',
      { backendNodeId: node.backendNodeId },
      { sessionId: session.cdpSessionId },
    );
    const quad = Array.isArray(quads.quads) ? quads.quads[0] : undefined;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw new Error(`Could not compute a clickable area for ${ref}`);
    }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await session.transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'left', clickCount: 1 },
      { sessionId: session.cdpSessionId },
    );
    await session.transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      { sessionId: session.cdpSessionId },
    );
    await session.transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      { sessionId: session.cdpSessionId },
    );
    await delay(250);
  }

  async typeText(sessionId: string, ref: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const node = await resolveRoleRef(
      session.transport,
      session.cdpSessionId,
      session.refMap,
      ref,
    );
    await session.transport.send(
      'DOM.focus',
      { backendNodeId: node.backendNodeId },
      { sessionId: session.cdpSessionId },
    );
    await session.transport.send(
      'Runtime.callFunctionOn',
      {
        objectId: node.objectId,
        functionDeclaration: `function () {
          if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
            this.value = '';
            this.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
          if (this.isContentEditable) {
            this.textContent = '';
          }
        }`,
      },
      { sessionId: session.cdpSessionId },
    );
    await session.transport.send(
      'Input.insertText',
      { text },
      { sessionId: session.cdpSessionId },
    );
  }

  async uploadFiles(
    sessionId: string,
    params: { ref?: string; selector?: string; files: string[] },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    let backendNodeId: number;
    if (params.ref) {
      backendNodeId = (
        await resolveRoleRef(
          session.transport,
          session.cdpSessionId,
          session.refMap,
          params.ref,
        )
      ).backendNodeId;
    } else if (params.selector) {
      const evaluated = await session.transport.send<{
        result?: { objectId?: string };
      }>(
        'Runtime.evaluate',
        {
          expression: `document.querySelector(${JSON.stringify(params.selector)})`,
          returnByValue: false,
          awaitPromise: false,
        },
        { sessionId: session.cdpSessionId },
      );
      const objectId = evaluated.result?.objectId;
      if (!objectId)
        throw new Error(`Could not find selector ${params.selector}`);
      const described = await session.transport.send<{
        node?: { backendNodeId?: number };
      }>('DOM.describeNode', { objectId }, { sessionId: session.cdpSessionId });
      backendNodeId = Number(described.node?.backendNodeId || 0);
    } else {
      throw new Error('ref or selector is required');
    }
    if (!backendNodeId) throw new Error('Could not resolve file input');
    for (const filePath of params.files) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`upload file not found: ${filePath}`);
      }
    }
    await session.transport.send(
      'DOM.setFileInputFiles',
      {
        files: params.files,
        backendNodeId,
      },
      { sessionId: session.cdpSessionId },
    );
  }

  async pressKey(sessionId: string, rawKey: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const payload = buildKeyPayload(rawKey);
    await session.transport.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', ...payload },
      { sessionId: session.cdpSessionId },
    );
    if (payload.text) {
      await session.transport.send(
        'Input.dispatchKeyEvent',
        { type: 'char', ...payload },
        { sessionId: session.cdpSessionId },
      );
    }
    await session.transport.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', ...payload },
      { sessionId: session.cdpSessionId },
    );
  }

  async scroll(
    sessionId: string,
    direction: 'up' | 'down',
    pixels = 800,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const distance = direction === 'up' ? -Math.abs(pixels) : Math.abs(pixels);
    await session.transport.send(
      'Runtime.evaluate',
      {
        expression: `window.scrollBy(0, ${distance});`,
        returnByValue: true,
      },
      { sessionId: session.cdpSessionId },
    );
  }

  async back(sessionId: string): Promise<PageInfo> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const history = await session.transport.send<{
      currentIndex?: number;
      entries?: Array<{ id?: number }>;
    }>('Page.getNavigationHistory', {}, { sessionId: session.cdpSessionId });
    const currentIndex = Number(history.currentIndex || 0);
    const previousEntry = history.entries?.[currentIndex - 1];
    if (!previousEntry?.id)
      throw new Error('No previous browser history entry');
    await session.transport.send(
      'Page.navigateToHistoryEntry',
      { entryId: previousEntry.id },
      { sessionId: session.cdpSessionId },
    );
    await this.waitForDocumentReady(session);
    return this.getPageInfo(session);
  }

  async listTabs(sessionId: string): Promise<BrowserTab[]> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    return this.listPageTargets(session.transport);
  }

  async openTab(sessionId: string, rawUrl: unknown): Promise<BrowserTab> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const tabs = await this.listPageTargets(session.transport);
    if (tabs.length >= MAX_TABS) {
      throw new Error(`Browser tab limit reached (${MAX_TABS})`);
    }
    const parsedUrl = await validateNavigationUrl(rawUrl);
    const created = await session.transport.send<{ targetId?: string }>(
      'Target.createTarget',
      { url: parsedUrl.toString() },
      { timeoutMs: 30_000 },
    );
    const targetId = String(created.targetId || '').trim();
    if (!targetId) throw new Error('Browser did not return a target id');
    await this.focusTab(sessionId, targetId);
    return this.getCurrentTab(session);
  }

  async focusTab(sessionId: string, targetId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    if (session.currentTargetId === targetId) return;
    await session.transport
      .send(
        'Target.detachFromTarget',
        { sessionId: session.cdpSessionId },
        { timeoutMs: 10_000 },
      )
      .catch(() => undefined);
    await session.transport.send('Target.activateTarget', { targetId });
    const cdpSessionId = await this.attachToTarget(session.transport, targetId);
    session.currentTargetId = targetId;
    session.cdpSessionId = cdpSessionId;
    session.refMap = {};
    session.lastSnapshotText = '';
    session.consoleMessages = [];
    session.networkRequests = [];
    session.networkRequestMap = new Map();
    await this.enableDomains(session);
    await this.waitForDocumentReady(session, 10_000).catch(() => undefined);
  }

  async closeTab(sessionId: string, targetId?: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const effectiveTargetId = targetId || session.currentTargetId;
    await session.transport.send('Target.closeTarget', {
      targetId: effectiveTargetId,
    });
    const remaining = await this.listPageTargets(session.transport);
    if (remaining.length === 0) {
      const created = await session.transport.send<{ targetId?: string }>(
        'Target.createTarget',
        { url: 'about:blank' },
      );
      const nextTargetId = String(created.targetId || '').trim();
      if (!nextTargetId) return;
      await this.focusTab(sessionId, nextTargetId);
      return;
    }
    const nextTab =
      remaining.find((tab) => tab.id !== effectiveTargetId) || remaining[0];
    await this.focusTab(sessionId, nextTab.id);
  }

  async readConsole(
    sessionId: string,
    options: { clear?: boolean } = {},
  ): Promise<BrowserConsoleMessage[]> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const messages = [...session.consoleMessages];
    if (options.clear) session.consoleMessages = [];
    return messages;
  }

  async readNetwork(
    sessionId: string,
    options: { clear?: boolean } = {},
  ): Promise<BrowserNetworkRequest[]> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const requests = [...session.networkRequests];
    if (options.clear) {
      session.networkRequests = [];
      session.networkRequestMap.clear();
    }
    return requests;
  }

  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const evaluated = await session.transport.send<{
      result?: { value?: unknown; description?: string };
    }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      { sessionId: session.cdpSessionId },
    );
    return evaluated.result?.value ?? evaluated.result?.description ?? null;
  }

  async screenshot(
    sessionId: string,
    options: { fullPage?: boolean } = {},
  ): Promise<BrowserScreenshotResult> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    return captureNormalizedScreenshot(
      session.transport,
      session.cdpSessionId,
      {
        fullPage: options.fullPage,
      },
    );
  }

  async printToPdf(sessionId: string): Promise<string> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const pdf = await session.transport.send<{ data?: string }>(
      'Page.printToPDF',
      { printBackground: true },
      { sessionId: session.cdpSessionId, timeoutMs: 60_000 },
    );
    const data = String(pdf.data || '');
    if (!data) throw new Error('PDF capture returned empty data');
    return data;
  }

  async getImages(sessionId: string): Promise<unknown[]> {
    const session = this.requireSession(sessionId);
    this.touch(session);
    const evaluated = await session.transport.send<{
      result?: { value?: unknown[] };
    }>(
      'Runtime.evaluate',
      {
        expression: EXTRACT_IMAGES_SCRIPT,
        returnByValue: true,
      },
      { sessionId: session.cdpSessionId },
    );
    return Array.isArray(evaluated.result?.value) ? evaluated.result.value : [];
  }

  async buildAnnotationBoxes(
    sessionId: string,
    screenshot: BrowserScreenshotResult,
  ): Promise<
    Array<{ ref: string; x: number; y: number; width: number; height: number }>
  > {
    const session = this.requireSession(sessionId);
    const boxes: Array<{
      ref: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    for (const [ref, roleRef] of Object.entries(session.refMap).slice(0, 60)) {
      if (!roleRef.backendNodeId) continue;
      try {
        const quads = await session.transport.send<{ quads?: number[][] }>(
          'DOM.getContentQuads',
          { backendNodeId: roleRef.backendNodeId },
          { sessionId: session.cdpSessionId, timeoutMs: 5_000 },
        );
        const quad = Array.isArray(quads.quads) ? quads.quads[0] : undefined;
        if (!Array.isArray(quad) || quad.length < 8) continue;
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        boxes.push({
          ref,
          x: Math.max(
            0,
            Math.round((minX - screenshot.clipX) * screenshot.scale),
          ),
          y: Math.max(
            0,
            Math.round((minY - screenshot.clipY) * screenshot.scale),
          ),
          width: Math.max(1, Math.round((maxX - minX) * screenshot.scale)),
          height: Math.max(1, Math.round((maxY - minY) * screenshot.scale)),
        });
      } catch {
        // Skip transiently stale nodes.
      }
    }
    return boxes;
  }

  getRefMap(sessionId: string): RoleRefMap {
    return { ...this.requireSession(sessionId).refMap };
  }

  private requireSession(sessionId: string): InternalSession {
    const normalized = normalizeSessionId(sessionId);
    const session = this.sessions.get(normalized);
    if (!session) {
      throw new Error(
        'Browser session is not started. Call browser_use with action="start" first.',
      );
    }
    return session;
  }

  private touch(session: InternalSession): void {
    session.lastActivityAt = Date.now();
  }

  private async cleanupIdleSessions(): Promise<void> {
    const threshold = Date.now() - IDLE_TIMEOUT_MS;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt >= threshold) continue;
      logBrowserSession(sessionId, 'cleaning up idle session', {
        idleMs: Date.now() - session.lastActivityAt,
      });
      await this.stop(sessionId);
    }
  }

  private async pickInitialTarget(
    transport: BrowserTransport,
  ): Promise<BrowserTab> {
    const targets = await this.listPageTargets(transport);
    const target = targets[targets.length - 1];
    if (target) return target;
    const created = await transport.send<{ targetId?: string }>(
      'Target.createTarget',
      {
        url: 'about:blank',
      },
    );
    const targetId = String(created.targetId || '').trim();
    if (!targetId) throw new Error('Failed to create an initial browser tab');
    const tabs = await this.listPageTargets(transport);
    return (
      tabs.find((entry) => entry.id === targetId) || {
        id: targetId,
        title: '',
        url: 'about:blank',
        type: 'page',
      }
    );
  }

  private async attachToTarget(
    transport: BrowserTransport,
    targetId: string,
  ): Promise<string> {
    const attached = await transport.send<{ sessionId?: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
      { timeoutMs: 30_000 },
    );
    const sessionId = String(attached.sessionId || '').trim();
    if (!sessionId)
      throw new Error(`Failed to attach to browser target ${targetId}`);
    return sessionId;
  }

  private async enableDomains(session: InternalSession): Promise<void> {
    const run = async (method: string, params?: Record<string, unknown>) => {
      try {
        await session.transport.send(method, params, {
          sessionId: session.cdpSessionId,
          timeoutMs: 15_000,
        });
      } catch {
        // Best effort: some domains may not be available on every target.
      }
    };
    await run('Page.enable');
    await run('Runtime.enable');
    await run('DOM.enable');
    await run('Network.enable');
    await run('Log.enable');
  }

  private handleEvent(
    session: InternalSession,
    event: { method: string; params?: unknown; sessionId?: string },
  ): void {
    if (event.sessionId && event.sessionId !== session.cdpSessionId) return;
    if (event.method === 'Runtime.consoleAPICalled') {
      const params = (event.params || {}) as Record<string, unknown>;
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((arg) => renderRemoteObject(arg))
        .filter(Boolean)
        .join(' ');
      if (!text) return;
      session.consoleMessages.push({
        level: String(params.type || 'log'),
        text,
        timestamp:
          typeof params.timestamp === 'number' ? params.timestamp : Date.now(),
      });
      session.consoleMessages = session.consoleMessages.slice(-200);
      return;
    }

    if (event.method === 'Page.javascriptDialogOpening') {
      const params = (event.params || {}) as Record<string, unknown>;
      const message = String(params.message || '').trim();
      if (!message) return;
      session.consoleMessages.push({
        level: 'dialog',
        text: message,
        timestamp: Date.now(),
      });
      session.consoleMessages = session.consoleMessages.slice(-200);
      return;
    }

    if (event.method === 'Network.requestWillBeSent') {
      const params = (event.params || {}) as Record<string, unknown>;
      const request = (params.request || {}) as Record<string, unknown>;
      const requestId = String(params.requestId || '').trim();
      const url = String(request.url || '').trim();
      if (!requestId || !url) return;
      const entry: BrowserNetworkRequest = {
        id: requestId,
        url,
        method: String(request.method || 'GET'),
        type: typeof params.type === 'string' ? String(params.type) : undefined,
        timestamp: Date.now(),
        status: null,
      };
      session.networkRequestMap.set(requestId, entry);
      session.networkRequests.push(entry);
      session.networkRequests = session.networkRequests.slice(-400);
      return;
    }

    if (event.method === 'Network.responseReceived') {
      const params = (event.params || {}) as Record<string, unknown>;
      const requestId = String(params.requestId || '').trim();
      const entry = session.networkRequestMap.get(requestId);
      const response = (params.response || {}) as Record<string, unknown>;
      if (!entry) return;
      entry.status =
        typeof response.status === 'number' ? response.status : entry.status;
      return;
    }

    if (event.method === 'Network.loadingFinished') {
      const params = (event.params || {}) as Record<string, unknown>;
      const requestId = String(params.requestId || '').trim();
      const entry = session.networkRequestMap.get(requestId);
      if (!entry) return;
      entry.durationMs = Date.now() - entry.timestamp;
      return;
    }

    if (event.method === 'Network.loadingFailed') {
      const params = (event.params || {}) as Record<string, unknown>;
      const requestId = String(params.requestId || '').trim();
      const entry = session.networkRequestMap.get(requestId);
      if (!entry) return;
      entry.failureText = String(params.errorText || 'Request failed');
      entry.durationMs = Date.now() - entry.timestamp;
    }
  }

  private async listPageTargets(
    transport: BrowserTransport,
  ): Promise<BrowserTab[]> {
    const targets = await transport.send<{
      targetInfos?: Array<{
        targetId?: string;
        title?: string;
        url?: string;
        type?: string;
        attached?: boolean;
      }>;
    }>('Target.getTargets', {});
    const tabs = (targets.targetInfos || [])
      .map((entry) => {
        const id = String(entry.targetId || '').trim();
        const type = String(entry.type || '').trim();
        if (!id || type !== 'page') return null;
        return {
          id,
          title: String(entry.title || ''),
          url: String(entry.url || ''),
          type,
          attached: entry.attached === true,
        };
      })
      .filter((entry) => entry !== null)
      .filter((entry) => !entry.url.startsWith('devtools://'));
    return tabs as BrowserTab[];
  }

  private async getCurrentTab(session: InternalSession): Promise<BrowserTab> {
    const tabs = await this.listPageTargets(session.transport);
    return (
      tabs.find((entry) => entry.id === session.currentTargetId) || {
        id: session.currentTargetId,
        title: '',
        url: '',
        type: 'page',
      }
    );
  }

  private async waitForDocumentReady(
    session: InternalSession,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastReadyState = '';
    let errorCount = 0;
    while (Date.now() < deadline) {
      try {
        const readyState = await session.transport.send<{
          result?: { value?: unknown };
        }>(
          'Runtime.evaluate',
          {
            expression: 'document.readyState',
            returnByValue: true,
            awaitPromise: false,
          },
          { sessionId: session.cdpSessionId, timeoutMs: 5_000 },
        );
        const value = String(readyState.result?.value || '');
        lastReadyState = value;
        if (value === 'complete' || value === 'interactive') {
          return;
        }
      } catch {
        // Retry until the timeout expires.
        errorCount += 1;
      }
      await delay(250);
    }
    logBrowserSession(session.sessionId, 'document ready wait timed out', {
      timeoutMs,
      targetId: session.currentTargetId,
      lastReadyState: lastReadyState || 'unknown',
      errorCount,
    });
  }

  private async getPageInfo(session: InternalSession): Promise<PageInfo> {
    const evaluated = await session.transport.send<{
      result?: { value?: { url?: string; title?: string } };
    }>(
      'Runtime.evaluate',
      {
        expression:
          '({ url: String(window.location.href || ""), title: String(document.title || "") })',
        returnByValue: true,
      },
      { sessionId: session.cdpSessionId, timeoutMs: 10_000 },
    );
    const value = (evaluated.result?.value || {}) as {
      url?: unknown;
      title?: unknown;
    };
    return {
      url: String(value.url || ''),
      title: String(value.title || ''),
    };
  }
}

function buildKeyPayload(rawKey: string): Record<string, string | number> {
  const key = String(rawKey || '').trim();
  if (!key) throw new Error('key is required');
  const specialMap: Record<
    string,
    { key: string; code: string; keyCode: number; text?: string }
  > = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  };

  const mapped = specialMap[key];
  if (mapped) {
    return {
      key: mapped.key,
      code: mapped.code,
      text: mapped.text ?? '',
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode,
    };
  }

  if (key.length === 1) {
    const upper = key.toUpperCase();
    const keyCode = upper.charCodeAt(0);
    return {
      key,
      code: /[a-z]/i.test(key)
        ? `Key${upper}`
        : /[0-9]/.test(key)
          ? `Digit${key}`
          : key,
      text: key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
  }

  return {
    key,
    code: key,
    text: '',
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0,
  };
}

export const browserSessionManager = new BrowserSessionManager();
