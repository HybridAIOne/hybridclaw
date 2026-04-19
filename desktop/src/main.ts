import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, nativeImage, shell } from 'electron';
import { type GatewayExitPayload, GatewayRuntime } from './gateway-runtime.js';
import {
  type DesktopRoute,
  isInAppUrl,
  normalizeGatewayBaseUrl,
  routeForUrl,
} from './gateway-target.js';
import { resolveRuntimeRoot } from './runtime-paths.js';
import { MAC_WINDOW_CHROME_CSS } from './window-chrome.js';

const APP_NAME = 'HybridClaw';
const IS_MAC = process.platform === 'darwin';

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function openExternalSafely(target: string): void {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return;
  }
  if (!SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) return;
  void shell.openExternal(parsed.toString());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
app.setName(APP_NAME);

const currentFile = fileURLToPath(import.meta.url);
const desktopIconPath = path.resolve(
  path.dirname(currentFile),
  '..',
  'build',
  'icon.png',
);
const runtimeRoot = resolveRuntimeRoot({
  currentFile,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
const gateway = new GatewayRuntime({
  baseUrl: normalizeGatewayBaseUrl(
    process.env.HYBRIDCLAW_DESKTOP_GATEWAY_URL ||
      process.env.GATEWAY_BASE_URL ||
      undefined,
  ),
  packaged: app.isPackaged,
  processEnv: process.env,
  processExecPath: process.execPath,
  runtimeRoot,
});
const runtimeVersion = readRuntimeVersion(runtimeRoot);
const hasDesktopIcon = fs.existsSync(desktopIconPath);

const windows = new Map<DesktopRoute, BrowserWindow>();
const windowRoutes = new Map<BrowserWindow, DesktopRoute>();
let aboutWindow: BrowserWindow | null = null;

function titleForRoute(route: DesktopRoute): string {
  return route === 'chat'
    ? 'HybridClaw Chat'
    : route === 'agents'
      ? 'HybridClaw Agents'
      : 'HybridClaw Admin';
}

const DEFAULT_WINDOW_WIDTH = 1440;

function getFocusedContentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused === aboutWindow || focused.isDestroyed()) {
    return null;
  }
  return focused;
}

function setWindowRoute(window: BrowserWindow, route: DesktopRoute): void {
  const previousRoute = windowRoutes.get(window);
  if (previousRoute && windows.get(previousRoute) === window) {
    windows.delete(previousRoute);
  }

  windowRoutes.set(window, route);
  windows.set(route, window);
  window.setTitle(titleForRoute(route));
}

function navigateWindow(
  window: BrowserWindow,
  route: DesktopRoute,
  targetUrl = gateway.routeUrl(route),
): BrowserWindow {
  setWindowRoute(window, route);

  if (window.webContents.getURL() !== targetUrl) {
    void window.loadURL(targetUrl);
  }

  window.show();
  window.focus();
  return window;
}

function syncWindowRouteFromUrl(
  window: BrowserWindow,
  targetUrl: string,
): void {
  const route = routeForUrl(targetUrl, gateway.baseUrl);
  if (!route) return;
  setWindowRoute(window, route);
}

async function syncWindowChrome(
  window: BrowserWindow,
  targetUrl: string,
): Promise<void> {
  const route =
    routeForUrl(targetUrl, gateway.baseUrl) ?? windowRoutes.get(window);
  if (!route || window.isDestroyed()) return;

  try {
    await window.webContents.executeJavaScript(
      `(() => {
        const route = ${JSON.stringify(route)};
        document.documentElement.dataset.hcDesktopRoute = route;

        for (const existing of document.querySelectorAll('.hc-electron-drag-strip')) {
          existing.remove();
        }

        for (const panel of document.querySelectorAll('[data-hc-main-panel], .workspace')) {
          if (!(panel instanceof HTMLElement)) continue;
          const strip = document.createElement('div');
          strip.className = 'hc-electron-drag-strip';
          strip.setAttribute('aria-hidden', 'true');
          panel.prepend(strip);
        }
      })();`,
      true,
    );
  } catch {
    // Ignore transient navigation races while the page is reloading.
  }
}

function readRuntimeVersion(root: string): string {
  const packageJsonPath = path.join(root, 'package.json');
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version
      : app.getVersion();
  } catch {
    return app.getVersion();
  }
}

let cachedAboutHtml: string | undefined;
function getAboutHtml(): string {
  if (cachedAboutHtml === undefined) {
    cachedAboutHtml = buildAboutHtml();
  }
  return cachedAboutHtml;
}

function buildAboutHtml(): string {
  const iconMarkup = hasDesktopIcon
    ? `<img src="${nativeImage.createFromPath(desktopIconPath).toDataURL()}" alt="HybridClaw logo" class="logo">`
    : `<div class="logo-fallback">HC</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About ${APP_NAME}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --panel: rgba(255, 255, 255, 0.92);
      --text: #0f172a;
      --muted: #475569;
      --line: rgba(148, 163, 184, 0.28);
      --shadow: 0 24px 64px rgba(15, 23, 42, 0.16);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      font-family: system-ui, ui-sans-serif, -apple-system, BlinkMacSystemFont, Inter, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(74, 108, 247, 0.12), transparent 36%),
        radial-gradient(circle at bottom right, rgba(15, 23, 42, 0.08), transparent 30%),
        var(--bg);
    }

    .card {
      width: min(560px, 100%);
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .hero {
      display: flex;
      align-items: center;
      gap: 18px;
      margin-bottom: 20px;
    }

    .logo,
    .logo-fallback {
      width: 72px;
      height: 72px;
      flex: 0 0 auto;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: #ffffff;
      box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.2);
    }

    .logo { object-fit: contain; padding: 6px; }

    .logo-fallback {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    h1 {
      margin: 0 0 4px;
      font-size: 2rem;
      line-height: 1.02;
      letter-spacing: -0.04em;
    }

    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0;
    }

    .metric {
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.8);
      border: 1px solid var(--line);
    }

    .metric-label {
      margin-bottom: 6px;
      font-size: 0.76rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .metric-value {
      font-size: 1rem;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 16px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      background: #0f172a;
      color: #ffffff;
    }

    button.secondary {
      background: #e2e8f0;
      color: #0f172a;
    }
  </style>
</head>
<body>
  <main class="card">
    <section class="hero">
      ${iconMarkup}
      <div>
        <h1>${APP_NAME}</h1>
        <p>Native macOS wrapper for the existing /chat, /agents, and /admin surfaces.</p>
      </div>
    </section>
    <section class="grid">
      <article class="metric">
        <div class="metric-label">Runtime Version</div>
        <div class="metric-value">v${runtimeVersion}</div>
      </article>
      <article class="metric">
        <div class="metric-label">Gateway</div>
        <div class="metric-value">${escapeHtml(gateway.baseUrl)}</div>
      </article>
    </section>
    <p>Use the app menu for Chat, Agents, and Admin, or restart the local gateway if the embedded surfaces need a fresh session.</p>
    <div class="actions">
      <button type="button" data-route="chat">Open Chat</button>
      <button type="button" data-route="agents">Open Agents</button>
      <button type="button" data-route="admin">Open Admin</button>
      <button type="button" class="secondary" data-action="close">Close</button>
    </div>
    <script>
      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const route = target.dataset.route;
        if (route) {
          window.location.assign('hc-about://' + route);
          return;
        }
        if (target.dataset.action === 'close') {
          window.close();
        }
      });
    </script>
  </main>
</body>
</html>`;
}

function openAboutWindow(): BrowserWindow {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return aboutWindow;
  }

  const window = new BrowserWindow({
    width: 620,
    height: 520,
    minWidth: 560,
    minHeight: 460,
    title: `About ${APP_NAME}`,
    titleBarStyle: 'hiddenInset',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    modal: false,
    backgroundColor: '#f8fafc',
    ...(hasDesktopIcon ? { icon: desktopIconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  aboutWindow = window;
  window.on('closed', () => {
    if (aboutWindow === window) {
      aboutWindow = null;
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('hc-about://')) {
      const candidate = url.slice('hc-about://'.length);
      if (
        candidate === 'chat' ||
        candidate === 'agents' ||
        candidate === 'admin'
      ) {
        void openRoute(candidate);
      }
      return { action: 'deny' };
    }
    openExternalSafely(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('hc-about://')) return;
    event.preventDefault();
    const candidate = url.slice('hc-about://'.length);
    if (
      candidate === 'chat' ||
      candidate === 'agents' ||
      candidate === 'admin'
    ) {
      void openRoute(candidate);
    }
  });

  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(getAboutHtml())}`,
  );
  return window;
}

function createWindow(
  route: DesktopRoute,
  targetUrl = gateway.routeUrl(route),
): BrowserWindow {
  const existing = windows.get(route);
  if (existing && !existing.isDestroyed()) {
    return navigateWindow(existing, route, targetUrl);
  }

  const window = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#ffffff',
    title: titleForRoute(route),
    titleBarStyle: 'hiddenInset',
    ...(hasDesktopIcon ? { icon: desktopIconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  setWindowRoute(window, route);
  window.on('closed', () => {
    const currentRoute = windowRoutes.get(window);
    if (currentRoute && windows.get(currentRoute) === window) {
      windows.delete(currentRoute);
    }
    windowRoutes.delete(window);
  });
  window.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  let chromeCssKey: string | undefined;
  window.webContents.on('did-finish-load', () => {
    if (IS_MAC) {
      const applyChrome = async () => {
        if (chromeCssKey) {
          await window.webContents.removeInsertedCSS(chromeCssKey);
        }
        chromeCssKey = await window.webContents.insertCSS(
          MAC_WINDOW_CHROME_CSS,
        );
        await syncWindowChrome(window, window.webContents.getURL());
      };
      void applyChrome();
    }
  });
  window.webContents.on('did-navigate', (_event, url) => {
    syncWindowRouteFromUrl(window, url);
    if (IS_MAC) {
      void syncWindowChrome(window, url);
    }
  });
  window.webContents.on('did-navigate-in-page', (_event, url) => {
    syncWindowRouteFromUrl(window, url);
    if (IS_MAC) {
      void syncWindowChrome(window, url);
    }
  });

  const handleWindowOpen = (target: string): void => {
    if (isInAppUrl(target, gateway.baseUrl)) {
      const nextRoute = routeForUrl(target, gateway.baseUrl);
      if (nextRoute) {
        navigateWindow(window, nextRoute, target);
      }
      return;
    }

    openExternalSafely(target);
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    handleWindowOpen(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isInAppUrl(url, gateway.baseUrl)) {
      syncWindowRouteFromUrl(window, url);
      return;
    }

    event.preventDefault();
    openExternalSafely(url);
  });

  window.webContents.on(
    'did-fail-load',
    (_event, code, description, validatedUrl) => {
      if (code === -3) return;
      dialog.showErrorBox(
        'Failed to load HybridClaw',
        `${description}\n\n${
          validatedUrl || gateway.routeUrl(windowRoutes.get(window) ?? route)
        }`,
      );
    },
  );

  return navigateWindow(window, route, targetUrl);
}

async function openRoute(route: DesktopRoute): Promise<void> {
  await gateway.ensureRunning();
  const focused = getFocusedContentWindow();
  if (focused) {
    navigateWindow(focused, route);
    return;
  }
  createWindow(route);
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        {
          label: 'Open Chat',
          accelerator: 'CmdOrCtrl+1',
          click: () => {
            void openRoute('chat');
          },
        },
        {
          label: 'Open Agents',
          accelerator: 'CmdOrCtrl+2',
          click: () => {
            void openRoute('agents');
          },
        },
        {
          label: 'Open Admin',
          accelerator: 'CmdOrCtrl+3',
          click: () => {
            void openRoute('admin');
          },
        },
        {
          label: 'Open Current Page in Browser',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            const target =
              focused?.webContents.getURL() || gateway.routeUrl('chat');
            openExternalSafely(target);
          },
        },
        {
          label: 'Restart Local Gateway',
          click: async () => {
            if (!gateway.startedChild) {
              await dialog.showMessageBox({
                type: 'info',
                message: 'HybridClaw is using an existing gateway process.',
                detail:
                  'Stop or restart the current gateway outside the desktop app, then reopen the window.',
              });
              return;
            }

            await gateway.restart();
            for (const window of BrowserWindow.getAllWindows()) {
              window.webContents.reload();
            }
          },
        },
        { type: 'separator' },
        IS_MAC ? { role: 'hide' } : { role: 'minimize' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            openAboutWindow();
          },
        },
      ],
    },
  ]);
}

function handleGatewayCrash(payload: GatewayExitPayload): void {
  dialog.showErrorBox(
    'HybridClaw gateway stopped',
    `The local gateway process exited unexpectedly (code ${String(payload.code)}, signal ${String(payload.signal)}).`,
  );
}

app.on('before-quit', () => {
  gateway.requestStop();
});
app.on('window-all-closed', () => {
  app.quit();
});

process.on('exit', () => {
  gateway.requestStop();
});

void app
  .whenReady()
  .then(async () => {
    app.setName(APP_NAME);
    Menu.setApplicationMenu(buildMenu());
    gateway.on('unexpected-exit', handleGatewayCrash);

    await openRoute('chat');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void openRoute('chat');
      }
    });
  })
  .catch((error) => {
    dialog.showErrorBox(
      'HybridClaw failed to start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
