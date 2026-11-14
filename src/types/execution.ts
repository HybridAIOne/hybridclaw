import type { EscalationTarget } from '@hybridclaw/contracts/agent-io';

export type {
  ArtifactMetadata,
  EscalationTarget,
  PendingApproval,
  PluginRuntimeToolDefinition,
  ToolExecution,
  ToolExecutionAnomalyScore,
  ToolExecutionStakesScore,
  ToolExecutionStakesSignal,
} from '@hybridclaw/contracts/agent-io';

export function normalizeEscalationTarget(
  value: unknown,
): EscalationTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as { channel?: unknown; recipient?: unknown };
  const channel = typeof raw.channel === 'string' ? raw.channel.trim() : '';
  const recipient =
    typeof raw.recipient === 'string' ? raw.recipient.trim() : '';
  return channel && recipient ? { channel, recipient } : undefined;
}

export function escalationTargetEquals(
  a?: EscalationTarget,
  b?: EscalationTarget,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.channel === b.channel && a.recipient === b.recipient;
}

/** Where the agent's browser is after a browser tool ran. */
export interface BrowserFrame {
  /** Origin and path only, never the query. */
  url: string;
  title: string;
  /** Viewport JPEG, served by `/api/artifact`; absent while frames are paused. */
  frame?: string;
  /** Set by `browser_sign_in` when nothing is saved for this host: ask the user. */
  signIn?: { host: string };
}

/** Set by `show_slide_samples`: sample slides to pick a new deck's look from. */
export interface SlideSamples {
  /** The card's heading; absent means the client's own. */
  question?: string;
  /** In slide order; `image` is a PNG served by `/api/artifact`. */
  looks: Array<{ title: string; note?: string; image: string }>;
  /** How the finished deck can be delivered: `powerpoint`, `google_slides`. */
  formats: string[];
}

export interface ToolProgressEvent {
  sessionId: string;
  toolName: string;
  /** The model's id for this call; pairs a finish with its start. */
  toolCallId?: string;
  phase: 'start' | 'finish';
  preview?: string;
  durationMs?: number;
  browser?: BrowserFrame;
  slideSamples?: SlideSamples;
}
