/**
 * Whether an action outside the sandbox really worked, from the tool calls of
 * its run: a connector's own success, or a `proof` the model recorded after a
 * matching check. `/receipts` (`receipts-command.ts`) and a reply's receipt
 * (`turn-receipt.ts`) share it. Kept apart from both so the stored-message
 * route can build a receipt without loading the command handlers.
 */

import type { StructuredAuditEntry } from '../types/audit.js';

const TEXT_LIMIT = 200;
const MAX_RECIPIENTS = 10;

/**
 * Whether the action really worked. `confirmed`: a check after it showed so;
 * `evidence` says which: the confirmation `email` (from a domain, with its
 * subject), a `screenshot` of the page (`path`, in the agent's home), the
 * `page` itself, or the connected `service`, whose tool reported success.
 * `unconfirmed`: nothing showed it; `summary` is why, when the model said.
 */
export interface ReceiptProof {
  status: 'confirmed' | 'unconfirmed';
  evidence: 'email' | 'screenshot' | 'page' | 'service' | null;
  summary: string | null;
  from: string | null;
  subject: string | null;
  path: string | null;
}

export function short(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

// `hybridai__google__send_mail` is Google's: the MCP server, then the service.
export function serviceOf(tool: string): string | null {
  const parts = tool.split('__').filter(Boolean);
  if (parts.length >= 3) return parts[1];
  if (parts.length === 2) return parts[0];
  return tool.startsWith('browser') ? 'browser' : null;
}

// Tools whose work stays in the sandbox: the file itself is the evidence.
const LOCAL_TOOLS = new Set(['write', 'edit', 'delete', 'bash']);
const MAIL_READ = /mail|message|inbox|thread/i;
const MAIL_WRITE =
  /send|reply|draft|forward|delete|trash|move|label|modify|update|create|archive|mark/i;

export interface RunCall {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  senders: string[];
  ok: boolean;
  result: string;
}

// `run-7:tool:3` is the third tool call of its run.
export function callIndex(toolCallId: unknown): number | null {
  const match = /:tool:(\d+)$/.exec(String(toolCallId ?? ''));
  return match ? Number(match[1]) : null;
}

export function domains(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(short)
        .filter((domain): domain is string => Boolean(domain))
        .slice(0, MAX_RECIPIENTS)
    : [];
}

// The copy of the screenshot the `proof` tool made, from its own answer.
function proofPath(result: string): string | null {
  try {
    const value = JSON.parse(result) as { path?: unknown };
    return typeof value.path === 'string' &&
      /^receipts\/[^/]+$/.test(value.path)
      ? value.path
      : null;
  } catch {
    return null;
  }
}

const UNCONFIRMED: ReceiptProof = {
  status: 'unconfirmed',
  evidence: null,
  summary: null,
  from: null,
  subject: null,
  path: null,
};

/**
 * The proof for the action at `index` of its run: the first `proof` call after
 * it, believed only when a matching check ran in between; else what the
 * action's own tool reported.
 */
export function proofFor(
  tool: string,
  index: number | null,
  calls: RunCall[],
): ReceiptProof | null {
  if (LOCAL_TOOLS.has(tool)) return null;
  const proof =
    index == null
      ? undefined
      : calls.find(
          (call) => call.index > index && call.tool === 'proof' && call.ok,
        );
  if (!proof || index == null) {
    return tool.includes('__') || tool === 'message'
      ? { ...UNCONFIRMED, status: 'confirmed', evidence: 'service' }
      : UNCONFIRMED;
  }
  const summary = short(proof.args.summary);
  if (proof.args.confirmed !== true) return { ...UNCONFIRMED, summary };
  const between = calls.filter(
    (call) => call.ok && call.index > index && call.index < proof.index,
  );
  const evidence = proof.args.evidence;
  if (evidence === 'email') {
    const read = between.some(
      (call) =>
        call.tool !== 'message' &&
        MAIL_READ.test(call.tool) &&
        !MAIL_WRITE.test(call.tool),
    );
    if (!read) return UNCONFIRMED;
    return {
      ...UNCONFIRMED,
      status: 'confirmed',
      evidence,
      summary,
      from: proof.senders[0] ?? null,
      subject: short(proof.args.subject),
    };
  }
  if (evidence === 'screenshot') {
    const path = proofPath(proof.result);
    if (!path || !between.some((call) => call.tool === 'browser_screenshot'))
      return UNCONFIRMED;
    return { ...UNCONFIRMED, status: 'confirmed', evidence, summary, path };
  }
  if (evidence === 'page') {
    // A click that returns the page it led to shows it too.
    const read =
      tool.startsWith('browser_') ||
      between.some((call) => call.tool.startsWith('browser_'));
    if (!read) return UNCONFIRMED;
    return { ...UNCONFIRMED, status: 'confirmed', evidence, summary };
  }
  return UNCONFIRMED;
}

export function payloadOf(
  entry: StructuredAuditEntry,
): Record<string, unknown> {
  try {
    const value = JSON.parse(entry.payload) as unknown;
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
