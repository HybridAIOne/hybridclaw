import type { Buffer } from 'node:buffer';
import type { SecretRef } from '../security/secret-refs.js';

export interface BrowserProvider {
  launchSession(opts: SessionOptions): Promise<BrowserSession>;
  closeSession(session: BrowserSession): Promise<void>;
}

export interface SessionOptions {
  /**
   * Persistent profile directory hint. Callers may pass the value returned by
   * getBrowserProfileDir(dataDir) from browser-login.ts.
   */
  profileDirHint?: string;
  headed?: boolean;
  viewport?: BrowserViewport;
  userAgent?: string;
  timeoutMs?: number;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserSession {
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  navigate(url: string, opts?: NavigateOptions): Promise<void>;
  back(opts?: NavigationOptions): Promise<void>;
  forward(opts?: NavigationOptions): Promise<void>;
  reload(opts?: NavigationOptions): Promise<void>;
  click(selector: string, opts?: ClickOptions): Promise<void>;
  fill(selector: string, value: SecretRef | string): Promise<void>;
  scroll(opts: ScrollOptions): Promise<void>;
  waitForSelector(selector: string, opts?: WaitOptions): Promise<void>;
}

export type BrowserActionName =
  | 'click'
  | 'fill'
  | 'scroll'
  | 'wait_for_selector'
  | 'screenshot'
  | 'evaluate'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload';

export type BrowserAction =
  | { name: 'click'; selector: string; opts?: ClickOptions }
  | { name: 'fill'; selector: string; value: SecretRef | string }
  | { name: 'scroll'; opts: ScrollOptions }
  | { name: 'wait_for_selector'; selector: string; opts?: WaitOptions }
  | { name: 'screenshot'; opts?: ScreenshotOptions }
  | { name: 'evaluate'; fn: () => unknown | Promise<unknown> }
  | { name: 'navigate'; url: string; opts?: NavigateOptions }
  | { name: 'back'; opts?: NavigationOptions }
  | { name: 'forward'; opts?: NavigationOptions }
  | { name: 'reload'; opts?: NavigationOptions };

export interface ClickOptions {
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  timeoutMs?: number;
}

export interface ScrollOptions {
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  deltaX?: number;
  deltaY?: number;
}

export interface WaitOptions {
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  type?: 'png' | 'jpeg';
}

export interface NavigateOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
}

export interface NavigationOptions {
  waitUntil?: NavigateOptions['waitUntil'];
  timeoutMs?: number;
}
