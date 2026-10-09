/**
 * `/receipts` — what the agent did outside its sandbox for the user: the mails
 * it sent, the events it made, the orders it placed, and who allowed each. It
 * reads the structured audit (`audit-events.ts`), so a run in the background,
 * such as a scheduled task's, has its receipt too, and the chat that asked
 * needs to have seen nothing of it.
 *
 * A chat sees its own receipts. A web chat also sees those of the agent's
 * other web chats and of the scheduled tasks it may manage, the line
 * `scheduled-task-access.ts` draws; a messaging-channel chat sees only its own
 * and its own tasks'. Companion apps list them with `--json`, answered in one
 * line that survives a chat relay (`chatSafeJson`).
 *
 * Each receipt says whether the action really worked (`proof`): a connector's
 * own tool reports that itself, and anything else, such as an order placed in
 * the browser, needs a `proof` the model recorded after it in the same turn.
 * That proof counts only when a matching check ran between the two: a mail
 * read for a confirmation email, a screenshot for a screenshot, a browser call
 * for a page. Otherwise the receipt says it could not be confirmed.
 */

import {
  getSessionById,
  listActionAuditEntries,
  listRunToolAuditEntries,
  listSessionIdsForAgentChannel,
  listSessionInstancesForKey,
} from '../memory/db.js';
import { resolveSessionIdCompat } from '../memory/sessions.js';
import { scheduledRunSessionKey } from '../session/session-key.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import type { Session } from '../types/session.js';
import { readWork } from '../work/work-store.js';
import {
  badCommand,
  infoCommand,
  plainCommand,
} from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';
import { listManageableScheduledTasks } from './scheduled-task-access.js';

const USAGE =
  'Usage: `/receipts [--limit <n>]` lists what the agent did outside its sandbox for you, such as mails it sent, and who allowed each. Add `--json` for a machine-readable answer.';

const TEXT_LIMIT = 200;
const MAX_RECIPIENTS = 10;

/**
 * Who let the action through. `you`: the user said yes to this one. `earlier`:
 * a yes for the session, the agent or everything given before. `full`: the
 * chat runs in full autonomy. `policy`: the approval policy let it run
 * without asking.
 */
export type ReceiptAllowance = 'you' | 'earlier' | 'full' | 'policy';

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

export interface Receipt {
  id: string;
  workId: string | null;
  at: string;
  session: string;
  // The scheduled task whose run did it; null for a chat turn.
  task: number | null;
  tool: string;
  // The connected service, as the tool names it (`google`, `microsoft365`).
  service: string | null;
  // The runtime's words for what it did, as it would have asked about it.
  action: string | null;
  // Where it wrote to, as domains ("@aa.com"): the audit keeps no addresses.
  to: string[];
  subject: string | null;
  title: string | null;
  when: string | null;
  url: string | null;
  allowed: ReceiptAllowance;
  ok: boolean;
  error: string | null;
  // Null for a failed action and for one that stays in the sandbox, such as
  // a file it wrote.
  proof: ReceiptProof | null;
}

function short(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

// A start time as a calendar tool takes it: a string, or `{dateTime}` / `{date}`.
function startTime(args: Record<string, unknown>): string | null {
  const start = args.start ?? args.start_time ?? args.startTime;
  if (start && typeof start === 'object') {
    const record = start as Record<string, unknown>;
    return short(record.dateTime ?? record.date_time ?? record.date);
  }
  return short(start);
}

function allowance(decision: unknown): ReceiptAllowance {
  switch (decision) {
    case 'approved_once':
      return 'you';
    case 'approved_session':
    case 'approved_agent':
    case 'approved_all':
    case 'promoted':
      return 'earlier';
    case 'approved_fullauto':
      return 'full';
    default:
      return 'policy';
  }
}

// `hybridai__google__send_mail` is Google's: the MCP server, then the service.
function serviceOf(tool: string): string | null {
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

interface RunCall {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  senders: string[];
  ok: boolean;
  result: string;
}

// `run-7:tool:3` is the third tool call of its run.
function callIndex(toolCallId: unknown): number | null {
  const match = /:tool:(\d+)$/.exec(String(toolCallId ?? ''));
  return match ? Number(match[1]) : null;
}

function argumentsOf(call: Record<string, unknown>): Record<string, unknown> {
  return call.arguments && typeof call.arguments === 'object'
    ? (call.arguments as Record<string, unknown>)
    : {};
}

function domains(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(short)
        .filter((domain): domain is string => Boolean(domain))
        .slice(0, MAX_RECIPIENTS)
    : [];
}

// The tool calls of each run, by `session\0run`, in order.
function runCalls(
  runs: { sessionId: string; runId: string }[],
): Map<string, RunCall[]> {
  const byRun = new Map<string, Map<number, RunCall>>();
  for (const entry of listRunToolAuditEntries(runs)) {
    const payload = payloadOf(entry);
    const index = callIndex(payload.toolCallId);
    if (index == null) continue;
    const key = `${entry.session_id}\u0000${entry.run_id}`;
    const calls = byRun.get(key) ?? new Map<number, RunCall>();
    byRun.set(key, calls);
    const call = calls.get(index) ?? {
      index,
      tool: String(payload.toolName ?? ''),
      args: {},
      senders: [],
      ok: false,
      result: '',
    };
    calls.set(index, call);
    if (entry.event_type === 'tool.call') {
      call.args = argumentsOf(payload);
      call.senders = domains(payload.senderDomains);
    } else {
      call.ok = payload.isError !== true && payload.blocked !== true;
      call.result = String(payload.resultFull ?? payload.resultSummary ?? '');
    }
  }
  return new Map(
    [...byRun].map(([key, calls]) => [
      key,
      [...calls.values()].sort((a, b) => a.index - b.index),
    ]),
  );
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
function proofFor(
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

function payloadOf(entry: StructuredAuditEntry): Record<string, unknown> {
  try {
    const value = JSON.parse(entry.payload) as unknown;
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The sessions whose receipts `requester` may read, each with the scheduled
 * task whose runs are stored under it, if any.
 */
function visibleSessions(requester: Session): Map<string, number | null> {
  const sessions = new Map<string, number | null>();
  sessions.set(resolveSessionIdCompat(requester.id), null);
  for (const instance of listSessionInstancesForKey(requester.session_key, {
    limit: 50,
  })) {
    sessions.set(instance.id, null);
  }
  if (requester.channel_id === 'web' && requester.agent_id) {
    for (const id of listSessionIdsForAgentChannel(requester.agent_id, 'web')) {
      sessions.set(id, null);
    }
  }
  for (const task of listManageableScheduledTasks(requester).tasks) {
    const agentId =
      getSessionById(task.session_id)?.agent_id || requester.agent_id;
    if (agentId)
      sessions.set(scheduledRunSessionKey(agentId, task.id), task.id);
  }
  return sessions;
}

export function listReceipts(requester: Session, limit: number): Receipt[] {
  const sessions = visibleSessions(requester);
  const calls = new Map<string, Record<string, Record<string, unknown>>>();
  const order: string[] = [];
  const meta = new Map<
    string,
    { session: string; at: string; runId: string }
  >();
  for (const entry of listActionAuditEntries([...sessions.keys()], limit)) {
    const payload = payloadOf(entry);
    const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
    if (!id) continue;
    const key = `${entry.session_id}\u0000${id}`;
    if (!calls.has(key)) {
      calls.set(key, {});
      order.push(key);
      meta.set(key, {
        session: entry.session_id,
        at: entry.timestamp,
        runId: entry.run_id,
      });
    }
    const rows = calls.get(key);
    if (rows) rows[entry.event_type] = payload;
  }
  const runs = runCalls(
    [...meta.values()].map(({ session, runId }) => ({
      sessionId: session,
      runId,
    })),
  );
  const receipts: Receipt[] = [];
  for (const key of order) {
    const rows = calls.get(key) ?? {};
    const call = rows['tool.call'];
    const result = rows['tool.result'];
    const decision = rows['autonomy.decision'];
    const info = meta.get(key);
    if (!call || !result || !info || result.blocked === true) continue;
    const tool = String(call.toolName ?? result.toolName ?? '');
    const args = argumentsOf(call);
    const ok = result.isError !== true;
    const at = new Date(info.at);
    receipts.push({
      id: String(call.toolCallId),
      workId: readWork(info.runId)?.id ?? null,
      at: Number.isNaN(at.getTime()) ? info.at : at.toISOString(),
      session: info.session,
      task: sessions.get(info.session) ?? null,
      tool,
      service: serviceOf(tool),
      action: short(rows['escalation.decision']?.proposedAction),
      to: domains(call.recipientDomains),
      subject: short(args.subject),
      title: short(args.summary ?? args.title),
      when: startTime(args),
      url: short(args.url),
      allowed: allowance(decision?.approvalDecision),
      ok,
      error: ok ? null : short(result.resultSummary),
      proof: ok
        ? proofFor(
            tool,
            callIndex(call.toolCallId),
            runs.get(`${info.session}\u0000${info.runId}`) ?? [],
          )
        : null,
    });
  }
  return receipts;
}

function line(receipt: Receipt): string {
  const what = receipt.action ?? `ran ${receipt.tool}`;
  const details = [
    receipt.to.length > 0 ? `to ${receipt.to.join(', ')}` : null,
    receipt.subject ? `"${receipt.subject}"` : null,
    receipt.title ? `"${receipt.title}"` : null,
    receipt.when ? `at ${receipt.when}` : null,
    receipt.url,
  ].filter(Boolean);
  const who = {
    you: 'you allowed it',
    earlier: 'allowed earlier',
    full: 'full autonomy',
    policy: 'no approval needed',
  }[receipt.allowed];
  const proof = receipt.proof
    ? receipt.proof.status === 'unconfirmed'
      ? " · couldn't confirm it worked"
      : receipt.proof.evidence === 'service'
        ? ''
        : ` · confirmed by ${receipt.proof.evidence}${receipt.proof.summary ? `: ${receipt.proof.summary}` : ''}`
    : '';
  const outcome = receipt.ok
    ? `${who}${proof}`
    : `failed: ${receipt.error ?? 'error'}`;
  const task = receipt.task != null ? ` · task #${receipt.task}` : '';
  return `${receipt.at} — ${what}${details.length > 0 ? ` (${details.join(', ')})` : ''} · ${outcome}${task}`;
}

export function handleReceiptsCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const rest = req.args.slice(1).map(String);
  let json = false;
  let limit = 30;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--limit') {
      const value = Number.parseInt(rest[index + 1] ?? '', 10);
      if (!Number.isFinite(value) || value < 1)
        return badCommand('Usage', USAGE);
      limit = Math.min(100, value);
      index += 1;
    } else {
      return badCommand('Usage', USAGE);
    }
  }
  const receipts = listReceipts(session, limit);
  if (json) return plainCommand(chatSafeJson({ version: 1, receipts }));
  if (receipts.length === 0) {
    return plainCommand('Nothing done outside the sandbox yet.');
  }
  return infoCommand('Receipts', receipts.map(line).join('\n'));
}
