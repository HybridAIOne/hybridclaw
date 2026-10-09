/**
 * A reply's receipt: what the agent read, sent and changed in that turn,
 * taken from its tool calls, never from its words. A client shows it next to
 * the reply, so "done" in the text always stands beside what the runtime saw:
 * a send that failed, a page it could not read, an order it could not confirm,
 * or nothing sent or changed at all.
 *
 * The turn that just ended builds it from its own tool executions; a stored
 * reply from its run's audit rows (`turn.end` names the message). Both go
 * through `buildTurnReceipt`, so they agree. Sorting follows the approval
 * policy's own call (`writeIntent`); rows from before it was recorded fall
 * back to the tier. Targets are short, with credentials and addresses taken
 * out: a receipt names a page or a subject, never a mail's text.
 *
 * NOT `/receipts` (`receipts-command.ts`): that lists every action across
 * chats for the Approvals pane; this is one turn, reads included.
 */

import { addressDomains, RECIPIENT_KEYS } from '../audit/audit-events.js';
import {
  listRunToolAuditEntries,
  runIdForAssistantMessage,
} from '../memory/db.js';
import { redactCredentialSecrets } from '../security/redact.js';
import type { ToolExecution } from '../types/execution.js';
import {
  callIndex,
  domains,
  payloadOf,
  proofFor,
  type ReceiptProof,
  type RunCall,
  serviceOf,
  short,
} from './receipt-proof.js';

export type TurnReceiptKind = 'read' | 'sent' | 'changed';

export interface TurnReceiptItem {
  kind: TurnReceiptKind;
  tool: string;
  // The connected service, as the tool names it (`google`), or `browser`.
  service: string | null;
  // What it was about: a subject, a title, a page, a file or a search.
  target: string | null;
  // Where it went, as domains ("@aa.com").
  to: string[];
  // Identical reads in a row count once.
  count: number;
  ok: boolean;
  // The approval policy stopped it, or the user said no.
  blocked: boolean;
  error: string | null;
  // For a send or change outside the sandbox: whether a check showed it
  // worked (`receipts-command.ts`). Null otherwise and when it failed.
  proof: ReceiptProof | null;
}

export interface TurnReceipt {
  version: 1;
  items: TurnReceiptItem[];
  // Items left out past the limit, reads first.
  more: number;
}

const MAX_ITEMS = 30;

// Bookkeeping: the agent's own cards, notes and lookups of its tools. They
// read or change nothing of the user's.
const SKIPPED_TOOLS = new Set([
  'proof',
  'delegate',
  'skills_list',
  'tool_catalog',
  'preferences',
  'work',
  'draft_email',
  'draft_transfer',
  'show_widget',
  'show_slide_samples',
  'estimate_cost',
  'react',
  'diagram_validate',
  'browser_close',
  'browser_console',
  'browser_network',
  'browser_await_two_factor',
  'browser_resume_interaction',
]);

// Built-in tools that change something without the policy saying so in rows
// recorded before `writeIntent`.
const WRITE_TOOLS = new Set(['write', 'edit', 'delete', 'memory', 'cron']);

const TARGET_KEYS = [
  'subject',
  'title',
  'summary',
  'name',
  'url',
  'path',
  'file_path',
  'query',
  'q',
];

interface TurnCall extends RunCall {
  recipients: string[];
  blocked: boolean;
  required: boolean;
  writeIntent: boolean | null;
  tier: string | null;
  error: string | null;
}

const EMAIL = /[\w.+%-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// A target as the user may see it: no credentials, no addresses.
function targetOf(args: Record<string, unknown>): string | null {
  for (const key of TARGET_KEYS) {
    const value = short(args[key]);
    if (!value) continue;
    return redactCredentialSecrets(value, true)
      .replace(EMAIL, '…')
      .replace(/\*\*\*EMAIL_REDACTED\*\*\*/g, '…');
  }
  return null;
}

function kindOf(call: TurnCall): TurnReceiptKind {
  const action = String(call.args.action ?? '').toLowerCase();
  if (call.recipients.length > 0) return 'sent';
  if (call.tool === 'message' && action === 'send') return 'sent';
  if (call.writeIntent != null) return call.writeIntent ? 'changed' : 'read';
  if (call.tier === 'red' || WRITE_TOOLS.has(call.tool)) return 'changed';
  return 'read';
}

// Outside the sandbox, where only a check shows it worked. A file, a note or
// a scheduled task is its own evidence.
function needsProof(tool: string): boolean {
  return (
    tool.includes('__') || tool === 'message' || tool.startsWith('browser_')
  );
}

export function buildTurnReceipt(calls: TurnCall[]): TurnReceipt {
  const ordered = [...calls].sort((a, b) => a.index - b.index);
  const items: TurnReceiptItem[] = [];
  for (const call of ordered) {
    if (!call.tool || call.required) continue;
    if (SKIPPED_TOOLS.has(call.tool) || call.tool.startsWith('middleware:'))
      continue;
    const kind = kindOf(call);
    const target = targetOf(call.args);
    const service = serviceOf(call.tool);
    // A read without a target, such as a scroll, says nothing on its own.
    if (kind === 'read' && !target && (!service || service === 'browser'))
      continue;
    const previous = items.at(-1);
    if (
      kind === 'read' &&
      previous?.kind === 'read' &&
      previous.tool === call.tool &&
      previous.target === target &&
      previous.ok === call.ok
    ) {
      previous.count += 1;
      continue;
    }
    items.push({
      kind,
      tool: call.tool,
      service,
      target,
      to: call.recipients,
      count: 1,
      ok: call.ok,
      blocked: call.blocked,
      error: call.ok ? null : call.error,
      proof:
        call.ok && kind !== 'read' && needsProof(call.tool)
          ? proofFor(call.tool, call.index, ordered)
          : null,
    });
  }
  // Over the limit, reads go first: what was sent or changed always shows.
  let more = 0;
  while (items.length > MAX_ITEMS) {
    let read = items.length - 1;
    while (read > 0 && items[read].kind !== 'read') read -= 1;
    items.splice(items[read].kind === 'read' ? read : items.length - 1, 1);
    more += 1;
  }
  return { version: 1, items, more };
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || '{}') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The receipt of the turn that just ran, from its tool executions. Empty when
 * it read, sent and changed nothing: a client can say so.
 */
export function turnReceiptFromExecutions(
  executions: readonly ToolExecution[],
): TurnReceipt {
  return buildTurnReceipt(
    executions.map((execution, position) => {
      const args = parseArgs(execution.arguments);
      const ok = execution.isError !== true && execution.blocked !== true;
      return {
        // The audit numbers calls the same way (`run:tool:<n>`).
        index: position + 1,
        tool: execution.name,
        args,
        senders:
          execution.name === 'proof' ? addressDomains(args, ['from']) : [],
        ok,
        result: execution.result,
        recipients: addressDomains(args, RECIPIENT_KEYS),
        blocked: execution.blocked === true,
        required: execution.approvalDecision === 'required',
        writeIntent:
          typeof execution.writeIntent === 'boolean'
            ? execution.writeIntent
            : null,
        tier: execution.approvalBaseTier ?? execution.approvalTier ?? null,
        error: ok ? null : short(execution.result),
      };
    }),
  );
}

/**
 * The receipt of a stored reply, from its run's audit rows; null when no run
 * names it, such as a reply from before the audit did.
 */
export function turnReceiptForMessage(
  sessionId: string,
  messageId: number,
): TurnReceipt | null {
  const runId = runIdForAssistantMessage(sessionId, messageId);
  if (!runId) return null;
  const calls = new Map<number, TurnCall>();
  for (const entry of listRunToolAuditEntries(
    [{ sessionId, runId }],
    ['tool.call', 'autonomy.decision', 'tool.result'],
  )) {
    const payload = payloadOf(entry);
    const index = callIndex(payload.toolCallId);
    if (index == null) continue;
    const call = calls.get(index) ?? {
      index,
      tool: '',
      args: {},
      senders: [],
      ok: false,
      result: '',
      recipients: [],
      blocked: false,
      required: false,
      writeIntent: null,
      tier: null,
      error: null,
    };
    calls.set(index, call);
    if (entry.event_type === 'tool.call') {
      call.tool = String(payload.toolName ?? call.tool);
      call.args =
        payload.arguments && typeof payload.arguments === 'object'
          ? (payload.arguments as Record<string, unknown>)
          : {};
      call.senders = domains(payload.senderDomains);
      call.recipients = domains(payload.recipientDomains);
    } else if (entry.event_type === 'autonomy.decision') {
      call.required = payload.approvalDecision === 'required';
      call.writeIntent =
        typeof payload.writeIntent === 'boolean' ? payload.writeIntent : null;
      const tier = payload.approvalBaseTier ?? payload.approvalTier;
      call.tier = typeof tier === 'string' ? tier : null;
    } else {
      call.tool ||= String(payload.toolName ?? '');
      call.blocked = payload.blocked === true;
      call.ok = payload.isError !== true && !call.blocked;
      call.result = String(payload.resultFull ?? payload.resultSummary ?? '');
      call.error = call.ok ? null : short(payload.resultSummary);
    }
  }
  return buildTurnReceipt([...calls.values()]);
}
