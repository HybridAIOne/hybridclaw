import type { Buffer } from 'node:buffer';
import type { SecretHandle } from '../security/secret-handles.js';
import type { SecretInput } from '../security/secret-refs.js';

export interface BrowserProvider {
  launchSession(opts: SessionOptions): Promise<BrowserSession>;
  closeSession(session: BrowserSession): Promise<void>;
  getCapabilities?(): BrowserProviderCapabilities;
}

export interface BrowserProviderCapabilities {
  credentialInjection: 'opaque-handle';
  waypointEvents: readonly BrowserWaypointEvent[];
}

export type BrowserFillInput = SecretInput | SecretHandle;

export interface SessionOptions {
  /**
   * Persistent profile directory hint. Callers may pass the value returned by
   * getBrowserProfileDir(dataDir) from browser-login.ts. Implementations must
   * normalize and constrain this path to an approved browser-profile root.
   */
  profileDirHint?: string;
  headed?: boolean;
  timeoutMs?: number;
  metering?: BrowserSessionMeteringContext;
}

export interface BrowserSessionMeteringContext {
  sessionId: string;
  agentId: string;
  tenantId?: string;
  auditRunId?: string;
  skillName?: string;
}

export interface BrowserTwoFactorState {
  detected: boolean;
  modality?: string | null;
  signals?: string[];
  url?: string | null;
  title?: string | null;
  preview?: string;
  selectors?: string[];
}

export interface BrowserTwoFactorCodeFillResult {
  selector?: string;
  strategy: string;
}

export type BrowserWaypointEvent =
  | 'browser_await_two_factor'
  | 'browser_resume_interaction';

export const DEFAULT_BROWSER_PROVIDER_CAPABILITIES: BrowserProviderCapabilities =
  {
    credentialInjection: 'opaque-handle',
    waypointEvents: ['browser_await_two_factor', 'browser_resume_interaction'],
  };

export interface BrowserSession {
  /**
   * Runs in the browser renderer context, not Node.js. Implementations should
   * restrict this path because page state may include cookies and localStorage.
   */
  evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  /**
   * Implementations must reject unsafe schemes such as file:// and javascript:.
   */
  navigate(url: string, opts?: NavigateOptions): Promise<void>;
  back(opts?: HistoryNavigationOptions): Promise<void>;
  forward(opts?: HistoryNavigationOptions): Promise<void>;
  reload(opts?: HistoryNavigationOptions): Promise<void>;
  click(selector: string, opts?: ClickOptions): Promise<void>;
  /**
   * Use SecretRef or an internal SecretHandle for credential, token, and
   * operator-return code fields. Plain strings are intended for non-sensitive
   * form values.
   */
  fill(selector: string, value: BrowserFillInput): Promise<void>;
  fillTwoFactorCode?(
    value: BrowserFillInput,
  ): Promise<BrowserTwoFactorCodeFillResult>;
  scroll(opts: ScrollOptions): Promise<void>;
  waitForSelector(selector: string, opts?: WaitOptions): Promise<void>;
  upload?(selector: string, files: string[]): Promise<void>;
  pdf?(opts?: PdfOptions): Promise<Buffer>;
  consoleMessages?(
    opts?: ConsoleMessageOptions,
  ): Promise<BrowserConsoleMessage[]>;
  inspectTwoFactorChallenge?(): Promise<BrowserTwoFactorState>;
  waypoint?(
    event: BrowserWaypointEvent,
    opts?: BrowserWaypointOptions,
  ): Promise<void>;
}

export type BrowserEvaluateFunction<T = unknown> = () => T | Promise<T>;

export type BrowserAction =
  | { name: 'click'; selector: string; opts?: ClickOptions }
  | { name: 'fill'; selector: string; value: BrowserFillInput }
  | { name: 'scroll'; opts: ScrollOptions }
  | { name: 'upload'; selector: string; files: string[] }
  | { name: 'pdf'; opts?: PdfOptions }
  | { name: 'console_messages'; opts?: ConsoleMessageOptions }
  | {
      name: 'waypoint';
      event: BrowserWaypointEvent;
      opts?: BrowserWaypointOptions;
    }
  | { name: 'wait_for_selector'; selector: string; opts?: WaitOptions }
  | { name: 'screenshot'; opts?: ScreenshotOptions }
  | { name: 'evaluate'; fn: BrowserEvaluateFunction }
  | { name: 'navigate'; url: string; opts?: NavigateOptions }
  | { name: 'back'; opts?: HistoryNavigationOptions }
  | { name: 'forward'; opts?: HistoryNavigationOptions }
  | { name: 'reload'; opts?: HistoryNavigationOptions };

export type BrowserActionName = BrowserAction['name'];

export interface ClickOptions {
  timeoutMs?: number;
}

export type ScrollOptions = {
  selector?: string;
} & (
  | { direction: ScrollDirection; deltaX?: number; deltaY?: number }
  | { deltaX: number; direction?: ScrollDirection; deltaY?: number }
  | { deltaY: number; direction?: ScrollDirection; deltaX?: number }
);

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface WaitOptions {
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
}

export interface PdfOptions {
  printBackground?: boolean;
  format?: string;
}

export interface BrowserConsoleMessage {
  level: string;
  text: string;
  timestamp: number;
}

export interface ConsoleMessageOptions {
  clear?: boolean;
  limit?: number;
}

export interface BrowserWaypointOptions {
  modality?: string;
  prompt?: string;
  sessionId?: string;
  responseKind?: string;
}

export interface NavigateOptions {
  waitUntil?: 'load' | 'domcontentloaded';
  timeoutMs?: number;
}

export interface HistoryNavigationOptions {
  waitUntil?: NavigateOptions['waitUntil'];
  timeoutMs?: number;
}
