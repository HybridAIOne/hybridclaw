import type { Buffer } from 'node:buffer';
import type { SecretRef } from '../security/secret-refs.js';

export interface BrowserProvider {
  launchSession(opts: SessionOptions): Promise<BrowserSession>;
  closeSession(session: BrowserSession): Promise<void>;
}

export interface SessionOptions {
  /**
   * Persistent profile directory hint. Callers may pass the value returned by
   * getBrowserProfileDir(dataDir) from browser-login.ts. Implementations must
   * normalize and constrain this path to an approved browser-profile root.
   */
  profileDirHint?: string;
  headed?: boolean;
  timeoutMs?: number;
}

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
   * Use SecretRef for credential or token fields. Plain strings are intended
   * for non-sensitive form values.
   */
  fill(selector: string, value: SecretRef | string): Promise<void>;
  scroll(opts: ScrollOptions): Promise<void>;
  waitForSelector(selector: string, opts?: WaitOptions): Promise<void>;
}

export type BrowserEvaluateFunction<T = unknown> = () => T | Promise<T>;

export type BrowserAction =
  | { name: 'click'; selector: string; opts?: ClickOptions }
  | { name: 'fill'; selector: string; value: SecretRef | string }
  | { name: 'scroll'; opts: ScrollOptions }
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

export interface NavigateOptions {
  waitUntil?: 'load' | 'domcontentloaded';
  timeoutMs?: number;
}

export interface HistoryNavigationOptions {
  waitUntil?: NavigateOptions['waitUntil'];
  timeoutMs?: number;
}
