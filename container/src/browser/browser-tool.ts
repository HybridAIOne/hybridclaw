import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveMediaPath,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from '../runtime-paths.js';
import type {
  TaskModelPolicies,
  ToolDefinition,
  ToolSchemaProperty,
} from '../types.js';
import { browserSessionManager } from './session-manager.js';
import { analyzeBrowserScreenshot } from './vision-fallback.js';

type BrowserModelContext = {
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio'
    | 'vllm';
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  requestHeaders: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
  maxTokens?: number;
};

const BROWSER_ARTIFACT_ROOT = path.join(WORKSPACE_ROOT, '.browser-artifacts');

let currentBrowserModelContext: BrowserModelContext = {
  provider: 'hybridai',
  baseUrl: '',
  apiKey: '',
  model: '',
  chatbotId: '',
  requestHeaders: {},
};
let currentBrowserTaskModels: TaskModelPolicies | undefined;

function cloneTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): TaskModelPolicies | undefined {
  const cloned: TaskModelPolicies = {};
  for (const [key, value] of Object.entries(taskModels || {})) {
    if (!value) continue;
    cloned[key as keyof TaskModelPolicies] = {
      ...value,
      requestHeaders: value.requestHeaders
        ? { ...value.requestHeaders }
        : undefined,
    };
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

export function setBrowserModelContext(
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio'
    | 'vllm'
    | undefined,
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
  requestHeaders?: Record<string, string>,
): void {
  currentBrowserModelContext = {
    provider: provider || 'hybridai',
    baseUrl: String(baseUrl || '')
      .trim()
      .replace(/\/+$/, ''),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim(),
    chatbotId: String(chatbotId || '').trim(),
    requestHeaders: { ...(requestHeaders || {}) },
  };
}

export function setBrowserTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): void {
  currentBrowserTaskModels = cloneTaskModelPolicies(taskModels);
}

function success(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload }, null, 2);
}

function failure(message: string): string {
  return JSON.stringify({ success: false, error: message }, null, 2);
}

function logBrowserTool(
  sessionId: string,
  action: string,
  phase: 'start' | 'done' | 'error',
  details?: Record<string, unknown>,
): void {
  const suffix =
    details && Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : '';
  console.error(
    `[browser_use] session=${sessionId} action=${action} phase=${phase}${suffix}`,
  );
}

function inferBrowserAction(
  name: string,
  args: Record<string, unknown>,
): string {
  if (name === 'browser_use') {
    return (
      String(args.action || '')
        .trim()
        .toLowerCase() || 'unknown'
    );
  }
  if (name === 'browser_navigate') return 'navigate';
  if (name === 'browser_snapshot') return 'snapshot';
  if (name === 'browser_click') return 'click';
  if (name === 'browser_type') return 'type';
  if (name === 'browser_upload') return 'upload';
  if (name === 'browser_press') return 'press_key';
  if (name === 'browser_scroll') return 'scroll';
  if (name === 'browser_back') return 'back';
  if (name === 'browser_screenshot') return 'screenshot';
  if (name === 'browser_pdf') return 'pdf';
  if (name === 'browser_vision') return 'vision';
  if (name === 'browser_get_images') return 'images';
  if (name === 'browser_console') return 'console';
  if (name === 'browser_network') return 'network';
  if (name === 'browser_close') return 'stop';
  return name;
}

function summarizeBrowserArgs(
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (action) {
    case 'start':
      return {
        headed: args.headed !== false,
        browser:
          typeof args.browser === 'string' && args.browser.trim()
            ? args.browser.trim()
            : 'default',
      };
    case 'navigate':
    case 'tab_open':
      return { url: String(args.url || '') };
    case 'snapshot':
      return { compact: args.compact !== false };
    case 'click':
      return { ref: String(args.ref || '') };
    case 'type':
      return {
        ref: String(args.ref || ''),
        textLength: String(args.text || '').length,
      };
    case 'upload':
      return {
        ref: typeof args.ref === 'string' ? args.ref : undefined,
        selector:
          typeof args.selector === 'string' ? args.selector.trim() : undefined,
        fileCount: Array.isArray(args.files)
          ? args.files.length
          : String(args.path || '').trim()
            ? 1
            : 0,
      };
    case 'scroll':
      return {
        direction: String(args.direction || ''),
        pixels: Number(args.pixels) || 800,
      };
    case 'press_key':
      return { key: String(args.key || '') };
    case 'tab_focus':
    case 'tab_close':
      return { tabId: String(args.tabId || args.targetId || '') };
    case 'console':
    case 'network':
      return { clear: args.clear === true };
    case 'evaluate':
      return { expressionLength: String(args.expression || '').length };
    case 'vision':
      return {
        questionLength: String(args.question || '').length,
        annotate: args.annotate === true,
      };
    case 'screenshot':
      return {
        fullPage: args.fullPage === true,
        path: typeof args.path === 'string' ? args.path.trim() : undefined,
      };
    case 'pdf':
      return {
        path: typeof args.path === 'string' ? args.path.trim() : undefined,
      };
    default:
      return {};
  }
}

function normalizeRef(rawRef: unknown): string {
  const ref = String(rawRef || '').trim();
  if (!ref) throw new Error('ref is required');
  return ref.startsWith('@') ? ref : `@${ref}`;
}

function ensureArtifactRoot(): string {
  fs.mkdirSync(BROWSER_ARTIFACT_ROOT, { recursive: true });
  return BROWSER_ARTIFACT_ROOT;
}

function resolveOutputPath(rawPath: unknown, extension: 'png' | 'pdf'): string {
  const root = ensureArtifactRoot();
  const requested = String(rawPath || '').trim();
  if (!requested) {
    const nonce = Math.random().toString(36).slice(2, 10);
    return path.join(root, `browser-${Date.now()}-${nonce}.${extension}`);
  }
  if (path.isAbsolute(requested)) {
    throw new Error('Absolute output paths are not allowed');
  }
  const clean = path.posix.normalize(requested.replace(/\\/g, '/'));
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error('Output path escapes the browser artifact root');
  }
  const withExtension = clean.endsWith(`.${extension}`)
    ? clean
    : `${clean}.${extension}`;
  const resolved = path.resolve(root, withExtension);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Output path escapes the browser artifact root');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function toArtifactResult(filePath: string): { path: string } {
  const relative = toWorkspaceRelativePath(filePath);
  if (!relative) {
    throw new Error('Could not map browser artifact into the workspace');
  }
  return { path: relative };
}

function resolveUploadPaths(args: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      candidates.push(value.trim());
      return;
    }
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        candidates.push(entry.trim());
      }
    }
  };

  add(args.path);
  add(args.file);
  add(args.files);
  add(args.paths);

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized =
      resolveWorkspacePath(candidate) || resolveMediaPath(candidate);
    if (!normalized) {
      throw new Error(
        `invalid upload path "${candidate}" (must stay within ${WORKSPACE_ROOT_DISPLAY} or ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY})`,
      );
    }
    if (!fs.existsSync(normalized)) {
      throw new Error(`upload file not found: ${normalized}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push(normalized);
  }
  if (resolved.length === 0) {
    throw new Error('path is required');
  }
  return resolved;
}

async function dispatchBrowserUse(
  args: Record<string, unknown>,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const action = String(args.action || '')
    .trim()
    .toLowerCase();
  if (!action) throw new Error('action is required');

  if (action === 'start') {
    const started = await browserSessionManager.start({
      sessionId,
      headed: args.headed !== false,
      preferredBrowser:
        typeof args.browser === 'string'
          ? (args.browser as
              | 'default'
              | 'chrome'
              | 'edge'
              | 'chromium'
              | 'safari')
          : 'default',
    });
    return {
      action,
      mode: started.mode,
      execution_mode: started.executionMode,
      browser: started.browser.name,
      browser_channel: started.browser.channel,
      current_tab: started.currentTab,
      ...(started.port ? { cdp_port: started.port } : {}),
      ...(started.warning ? { warning: started.warning } : {}),
    };
  }

  if (action === 'stop') {
    await browserSessionManager.stop(sessionId);
    return { action, stopped: true };
  }

  if (action === 'navigate') {
    await browserSessionManager.start({
      sessionId,
      headed: args.headed !== false,
      preferredBrowser:
        typeof args.browser === 'string'
          ? (args.browser as
              | 'default'
              | 'chrome'
              | 'edge'
              | 'chromium'
              | 'safari')
          : 'default',
    });
    const result = await browserSessionManager.navigate(sessionId, args.url);
    return {
      action,
      url: result.url,
      title: result.title,
      snapshot: result.snapshot.text,
      refs: Object.keys(result.snapshot.refMap).length,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  if (action === 'snapshot') {
    const snapshot = await browserSessionManager.snapshot(sessionId, {
      compact: args.compact !== false,
    });
    return {
      action,
      snapshot: snapshot.text,
      refs: Object.keys(snapshot.refMap).length,
      interactive_refs: snapshot.interactiveCount,
    };
  }

  if (action === 'click') {
    await browserSessionManager.click(sessionId, normalizeRef(args.ref));
    return { action, ref: normalizeRef(args.ref) };
  }

  if (action === 'type') {
    const text = String(args.text || '');
    if (!text) throw new Error('text is required');
    await browserSessionManager.typeText(
      sessionId,
      normalizeRef(args.ref),
      text,
    );
    return { action, ref: normalizeRef(args.ref), typed_chars: text.length };
  }

  if (action === 'upload') {
    await browserSessionManager.uploadFiles(sessionId, {
      ref: args.ref ? normalizeRef(args.ref) : undefined,
      selector:
        typeof args.selector === 'string'
          ? String(args.selector).trim()
          : undefined,
      files: resolveUploadPaths(args),
    });
    return {
      action,
      ...(args.ref ? { ref: normalizeRef(args.ref) } : {}),
      ...(typeof args.selector === 'string' && args.selector.trim()
        ? { selector: args.selector.trim() }
        : {}),
    };
  }

  if (action === 'scroll') {
    const direction = String(args.direction || '')
      .trim()
      .toLowerCase();
    if (direction !== 'up' && direction !== 'down') {
      throw new Error('direction must be "up" or "down"');
    }
    const pixels = Number(args.pixels);
    await browserSessionManager.scroll(
      sessionId,
      direction,
      Number.isFinite(pixels) && pixels > 0 ? Math.floor(pixels) : 800,
    );
    return { action, direction };
  }

  if (action === 'press_key') {
    const key = String(args.key || '').trim();
    if (!key) throw new Error('key is required');
    await browserSessionManager.pressKey(sessionId, key);
    return { action, key };
  }

  if (action === 'back') {
    const result = await browserSessionManager.back(sessionId);
    return { action, ...result };
  }

  if (action === 'tabs') {
    const tabs = await browserSessionManager.listTabs(sessionId);
    return { action, count: tabs.length, tabs };
  }

  if (action === 'tab_open') {
    const tab = await browserSessionManager.openTab(sessionId, args.url);
    return { action, tab };
  }

  if (action === 'tab_focus') {
    const tabId = String(args.tabId || args.targetId || '').trim();
    if (!tabId) throw new Error('tabId is required');
    await browserSessionManager.focusTab(sessionId, tabId);
    return { action, tabId };
  }

  if (action === 'tab_close') {
    const tabId = String(args.tabId || '').trim();
    await browserSessionManager.closeTab(sessionId, tabId || undefined);
    return { action, ...(tabId ? { tabId } : {}) };
  }

  if (action === 'console') {
    const messages = await browserSessionManager.readConsole(sessionId, {
      clear: args.clear === true,
    });
    return {
      action,
      count: args.clear === true ? 0 : messages.length,
      messages: args.clear === true ? [] : messages,
      ...(args.clear === true ? { cleared: true } : {}),
    };
  }

  if (action === 'evaluate') {
    const expression = String(args.expression || '').trim();
    if (!expression) throw new Error('expression is required');
    return {
      action,
      result: await browserSessionManager.evaluate(sessionId, expression),
    };
  }

  if (action === 'screenshot') {
    const screenshot = await browserSessionManager.screenshot(sessionId, {
      fullPage: args.fullPage === true,
    });
    const outputPath = resolveOutputPath(args.path, 'png');
    fs.writeFileSync(outputPath, Buffer.from(screenshot.base64, 'base64'));
    return {
      action,
      ...toArtifactResult(outputPath),
      full_page: args.fullPage === true,
    };
  }

  if (action === 'pdf') {
    const outputPath = resolveOutputPath(args.path, 'pdf');
    const base64 = await browserSessionManager.printToPdf(sessionId);
    fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
    return { action, ...toArtifactResult(outputPath) };
  }

  if (action === 'images') {
    const images = await browserSessionManager.getImages(sessionId);
    return {
      action,
      count: Array.isArray(images) ? images.length : 0,
      images,
    };
  }

  if (action === 'network') {
    const requests = await browserSessionManager.readNetwork(sessionId, {
      clear: args.clear === true,
    });
    return {
      action,
      count: args.clear === true ? 0 : requests.length,
      requests: args.clear === true ? [] : requests,
      ...(args.clear === true ? { cleared: true } : {}),
    };
  }

  if (action === 'vision') {
    const question = String(args.question || '').trim();
    if (!question) throw new Error('question is required');
    const screenshot = await browserSessionManager.screenshot(sessionId, {
      fullPage: false,
    });
    const annotationBoxes =
      args.annotate === true
        ? await browserSessionManager.buildAnnotationBoxes(
            sessionId,
            screenshot,
          )
        : [];
    const vision = await analyzeBrowserScreenshot({
      screenshot,
      question,
      annotate: args.annotate === true,
      annotationBoxes,
      fallbackContext: currentBrowserModelContext,
      taskModels: currentBrowserTaskModels,
    });
    return {
      action,
      model: vision.model,
      analysis: vision.analysis,
      ...toArtifactResult(vision.path),
      ...(vision.annotatedPath
        ? { annotated_path: toArtifactResult(vision.annotatedPath).path }
        : {}),
    };
  }

  throw new Error(`Unknown browser action: ${action}`);
}

export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  const action = inferBrowserAction(name, args);
  const startedAt = Date.now();
  logBrowserTool(
    sessionId,
    action,
    'start',
    summarizeBrowserArgs(action, args),
  );
  try {
    let payload: Record<string, unknown>;
    switch (name) {
      case 'browser_use':
        payload = await dispatchBrowserUse(args, sessionId);
        break;
      case 'browser_navigate':
        payload = await dispatchBrowserUse(
          {
            action: 'navigate',
            url: args.url,
            browser: args.browser,
            headed: args.headed,
          },
          sessionId,
        );
        break;
      case 'browser_snapshot':
        payload = await dispatchBrowserUse(
          {
            action: 'snapshot',
            compact: args.mode === 'full' ? false : args.compact,
          },
          sessionId,
        );
        break;
      case 'browser_click':
        payload = await dispatchBrowserUse(
          { action: 'click', ref: args.ref },
          sessionId,
        );
        break;
      case 'browser_type':
        payload = await dispatchBrowserUse(
          { action: 'type', ref: args.ref, text: args.text },
          sessionId,
        );
        break;
      case 'browser_upload':
        payload = await dispatchBrowserUse(
          {
            action: 'upload',
            ref: args.ref,
            selector: args.selector,
            path: args.path,
            files: args.files,
            paths: args.paths,
          },
          sessionId,
        );
        break;
      case 'browser_press':
        payload = await dispatchBrowserUse(
          { action: 'press_key', key: args.key },
          sessionId,
        );
        break;
      case 'browser_scroll':
        payload = await dispatchBrowserUse(
          {
            action: 'scroll',
            direction: args.direction,
            pixels: args.pixels,
          },
          sessionId,
        );
        break;
      case 'browser_back':
        payload = await dispatchBrowserUse({ action: 'back' }, sessionId);
        break;
      case 'browser_screenshot':
        payload = await dispatchBrowserUse(
          {
            action: 'screenshot',
            path: args.path,
            fullPage: args.fullPage,
          },
          sessionId,
        );
        break;
      case 'browser_pdf':
        payload = await dispatchBrowserUse(
          { action: 'pdf', path: args.path },
          sessionId,
        );
        break;
      case 'browser_vision':
        payload = await dispatchBrowserUse(
          {
            action: 'vision',
            question: args.question,
            annotate: args.annotate,
          },
          sessionId,
        );
        break;
      case 'browser_get_images':
        payload = await dispatchBrowserUse({ action: 'images' }, sessionId);
        break;
      case 'browser_console':
        payload = await dispatchBrowserUse(
          { action: 'console', clear: args.clear },
          sessionId,
        );
        break;
      case 'browser_network':
        payload = await dispatchBrowserUse(
          { action: 'network', clear: args.clear },
          sessionId,
        );
        break;
      case 'browser_close':
        payload = await dispatchBrowserUse({ action: 'stop' }, sessionId);
        break;
      default:
        return failure(`Unknown browser tool: ${name}`);
    }
    logBrowserTool(sessionId, action, 'done', {
      durationMs: Date.now() - startedAt,
    });
    return success(payload);
  } catch (error) {
    logBrowserTool(sessionId, action, 'error', {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function stringProperty(description: string): ToolSchemaProperty {
  return { type: 'string', description };
}

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_use',
      description:
        'Control a desktop browser through a persistent CDP session. Use this for auth-gated pages, logged-in desktop browsing, tab management, ARIA snapshots, screenshots, and browser interaction.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'start',
              'stop',
              'navigate',
              'snapshot',
              'screenshot',
              'click',
              'type',
              'upload',
              'scroll',
              'press_key',
              'back',
              'tabs',
              'tab_open',
              'tab_focus',
              'tab_close',
              'console',
              'network',
              'evaluate',
              'vision',
              'pdf',
              'images',
            ],
            description: 'Browser action to perform.',
          },
          url: stringProperty('URL for navigate or tab_open.'),
          ref: stringProperty(
            'Element ref from a browser snapshot, for example @e5.',
          ),
          text: stringProperty('Text to type into the resolved element.'),
          key: stringProperty(
            'Keyboard key for press_key, for example Enter or Tab.',
          ),
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Scroll direction.',
          },
          pixels: {
            type: 'number',
            description: 'Optional scroll distance in pixels.',
          },
          path: stringProperty(
            'Optional artifact path under /workspace/.browser-artifacts for screenshot or pdf output.',
          ),
          fullPage: {
            type: 'boolean',
            description: 'Capture a full-page screenshot.',
          },
          compact: {
            type: 'boolean',
            description:
              'Compact the ARIA snapshot by trimming structural nodes.',
          },
          headed: {
            type: 'boolean',
            description:
              'When starting a browser, prefer a visible headed browser window.',
          },
          browser: {
            type: 'string',
            enum: ['default', 'chrome', 'edge', 'chromium', 'safari'],
            description: 'Preferred browser for start.',
          },
          tabId: stringProperty('Target tab id for tab_focus or tab_close.'),
          selector: stringProperty(
            'CSS selector for upload when no ref is available.',
          ),
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional upload files.',
          },
          question: stringProperty('Question for screenshot vision analysis.'),
          expression: stringProperty('JavaScript expression for evaluate.'),
          clear: {
            type: 'boolean',
            description: 'Clear console or network buffers after reading them.',
          },
          annotate: {
            type: 'boolean',
            description:
              'Annotate interactive refs on the screenshot for vision analysis when supported.',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Legacy wrapper for browser_use(action="navigate"). Opens a URL in a persistent browser session and returns an ARIA snapshot.',
      parameters: {
        type: 'object',
        properties: {
          url: stringProperty('URL to open (http:// or https://).'),
          headed: {
            type: 'boolean',
            description:
              'Prefer a visible headed browser window when starting the browser.',
          },
          browser: {
            type: 'string',
            enum: ['default', 'chrome', 'edge', 'chromium', 'safari'],
            description: 'Preferred browser for navigation startup.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        'Legacy wrapper for browser_use(action="snapshot"). Returns the current ARIA snapshot with refs.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['default', 'interactive', 'full'],
            description: 'Snapshot mode hint kept for compatibility.',
          },
          compact: {
            type: 'boolean',
            description: 'Compact structural nodes.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Legacy wrapper for browser_use(action="click").',
      parameters: {
        type: 'object',
        properties: {
          ref: stringProperty('Element ref from the current browser snapshot.'),
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Legacy wrapper for browser_use(action="type").',
      parameters: {
        type: 'object',
        properties: {
          ref: stringProperty('Element ref from the current browser snapshot.'),
          text: stringProperty('Text to type into the resolved element.'),
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_upload',
      description: 'Legacy wrapper for browser_use(action="upload").',
      parameters: {
        type: 'object',
        properties: {
          ref: stringProperty(
            'Optional browser snapshot ref for the file input.',
          ),
          selector: stringProperty('Optional CSS selector for the file input.'),
          path: stringProperty('Primary upload file path.'),
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional additional upload file paths.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: 'Legacy wrapper for browser_use(action="press_key").',
      parameters: {
        type: 'object',
        properties: {
          key: stringProperty('Keyboard key to press.'),
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Legacy wrapper for browser_use(action="scroll").',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Scroll direction.',
          },
          pixels: {
            type: 'number',
            description: 'Optional scroll distance in pixels.',
          },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Legacy wrapper for browser_use(action="back").',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Legacy wrapper for browser_use(action="screenshot").',
      parameters: {
        type: 'object',
        properties: {
          path: stringProperty(
            'Optional artifact path under .browser-artifacts.',
          ),
          fullPage: {
            type: 'boolean',
            description: 'Capture the full page instead of only the viewport.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_pdf',
      description: 'Legacy wrapper for browser_use(action="pdf").',
      parameters: {
        type: 'object',
        properties: {
          path: stringProperty(
            'Optional artifact path under .browser-artifacts.',
          ),
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_vision',
      description: 'Legacy wrapper for browser_use(action="vision").',
      parameters: {
        type: 'object',
        properties: {
          question: stringProperty(
            'Question to ask about the current browser view.',
          ),
          annotate: {
            type: 'boolean',
            description:
              'Annotate browser refs on the screenshot when supported.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_images',
      description: 'Legacy wrapper for browser_use(action="images").',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description: 'Legacy wrapper for browser_use(action="console").',
      parameters: {
        type: 'object',
        properties: {
          clear: {
            type: 'boolean',
            description: 'Clear the console buffer after reading it.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network',
      description: 'Legacy wrapper for browser_use(action="network").',
      parameters: {
        type: 'object',
        properties: {
          clear: {
            type: 'boolean',
            description: 'Clear the network buffer after reading it.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Legacy wrapper for browser_use(action="stop").',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];
