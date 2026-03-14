import type { ChildProcess } from 'node:child_process';

export type BrowserEngine = 'chromium' | 'webkit' | 'unknown';
export type BrowserChannel =
  | 'chrome'
  | 'edge'
  | 'chromium'
  | 'safari'
  | 'unknown';
export type BrowserConnectionMode =
  | 'direct'
  | 'extension-relay'
  | 'agent-launched';
export type BrowserExecutionMode = 'host' | 'container' | 'unknown';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  type: string;
  attached?: boolean;
  wsUrl?: string;
}

export interface BrowserCandidate {
  channel: BrowserChannel;
  engine: BrowserEngine;
  name: string;
  executablePath: string | null;
  userDataDir: string | null;
  bundleId?: string;
  source: 'default' | 'installed' | 'explicit';
  defaultBrowser?: boolean;
  warning?: string;
}

export interface BrowserLaunchResult {
  browser: BrowserCandidate;
  mode: BrowserConnectionMode;
  wsUrl: string;
  port?: number;
  process?: ChildProcess | null;
}

export interface CdpTargetInfo {
  targetId: string;
  title: string;
  url: string;
  type: string;
  attached?: boolean;
}

export interface CdpEventMessage {
  method: string;
  params?: unknown;
  sessionId?: string;
}

export interface CdpWaitForEventOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface CdpSendOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface AriaNodeValue {
  type?: string;
  value?: string | number | boolean | null;
}

export interface AriaNodeProperty {
  name: string;
  value?: AriaNodeValue;
}

export interface AriaNode {
  nodeId: string;
  ignored?: boolean;
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
  childIds?: string[];
  role?: AriaNodeValue;
  name?: AriaNodeValue;
  value?: AriaNodeValue;
  description?: AriaNodeValue;
  properties?: AriaNodeProperty[];
}

export type SnapshotNodeKind = 'interactive' | 'content' | 'structural';

export interface RoleRef {
  role: string;
  name?: string;
  nth?: number;
  backendNodeId?: number;
}

export type RoleRefMap = Record<string, RoleRef>;

export interface SnapshotNode {
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  backendNodeId?: number;
  ignored?: boolean;
  kind: SnapshotNodeKind;
  children: SnapshotNode[];
}

export interface FormattedAriaSnapshot {
  text: string;
  refMap: RoleRefMap;
  tree: SnapshotNode[];
  totalCount: number;
  interactiveCount: number;
}

export interface BrowserConsoleMessage {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
}

export interface BrowserNetworkRequest {
  id: string;
  url: string;
  method: string;
  type?: string;
  status?: number | null;
  timestamp: number;
  durationMs?: number | null;
  failureText?: string | null;
}

export interface BrowserScreenshotResult {
  base64: string;
  width: number;
  height: number;
  clipX: number;
  clipY: number;
  scale: number;
}

export interface BrowserVisionResult {
  model: string;
  analysis: string;
  path: string;
  annotatedPath?: string;
}
