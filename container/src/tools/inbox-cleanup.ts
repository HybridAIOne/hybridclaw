/**
 * `inbox_cleanup`: archive bulk mail (newsletters, promotions, notifications)
 * from the user's own IMAP mailbox in groups the user approves, with undo.
 * `plan` reads headers and freezes the uids of each sender group in a plan file
 * under `.hybridclaw/`, which the agent's own file tools cannot edit. `apply`
 * moves exactly those uids to Archive and asks in every approval mode; `undo`
 * moves them back. Nothing here can delete mail: the connector's only write is
 * a move to Archive or back, and the model may not call that move directly.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ClassifiedAction } from '../approval-policy.js';
import { WORKSPACE_ROOT } from '../runtime-paths.js';
import type { ToolDefinition, ToolRunResult } from '../types.js';

export const INBOX_CLEANUP_TOOL = 'inbox_cleanup';

const CONNECTOR = 'hybridai__mailbox__';
const LIST_HEADERS = `${CONNECTOR}list_message_headers`;
const LIST_FOLDERS = `${CONNECTOR}list_folders`;
const MOVE = `${CONNECTOR}move_messages`;
// The connector primitives inbox_cleanup drives; the model never sees them.
const HIDDEN_TOOLS = new Set([LIST_HEADERS, MOVE]);
const MOVE_TOOL = /^hybridai__[a-z0-9_]+__move_messages$/;

const PAGE = 1000;
const DEFAULT_SCAN = 10_000;
const MAX_SCAN = 50_000;
const SENT_SCAN = 2_000;
const RECENT_DAYS = 7;
const MIN_GROUP = 2;
const SURE_GROUP = 5;
const SHOWN_GROUPS = 40;
const PLAN_TTL_MS = 24 * 3600_000;
const UNDO_TTL_MS = 30 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

export interface McpCaller {
  isKnownTool(name: string): boolean;
  callToolDetailed(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolRunResult>;
}

interface Header {
  uid: number;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  list_id: string | null;
  list_unsubscribe: boolean;
  precedence: string | null;
  auto_submitted: string | null;
  is_unread: boolean;
  is_flagged: boolean;
  is_answered: boolean;
}

interface HeaderPage {
  uidvalidity: number;
  matched: number;
  messages: Header[];
  next_before_uid: number | null;
}

interface Group {
  id: string;
  name: string;
  sender: string;
  list_id: string | null;
  count: number;
  unread: number;
  newest: string | null;
  oldest: string | null;
  samples: string[];
  sure: boolean;
  uids: number[];
}

type Protected = Record<
  'starred' | 'replied' | 'people' | 'recent' | 'not_bulk',
  number
>;

interface Receipt {
  applied_at: string;
  groups: string[];
  archive_folder: string | null;
  archive_uidvalidity: number | null;
  moved: [number, number | null][];
  skipped: Record<string, number>;
  error?: string;
  undone_at?: string;
  undo_skipped?: Record<string, number>;
}

interface Plan {
  version: 1;
  id: string;
  created_at: string;
  folder: 'INBOX';
  uidvalidity: number;
  inbox_total: number;
  looked_at: number;
  groups: Group[];
  protected: Protected;
  receipt?: Receipt;
}

export const INBOX_CLEANUP_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: INBOX_CLEANUP_TOOL,
    description:
      "Tidy the user's own mailbox (the mailbox connector) by archiving bulk mail in sender groups. " +
      '`plan` looks at the newest inbox mail by sender and mail headers and returns groups of newsletters, ' +
      'promotions and notifications, plus how many emails it leaves alone (from people the user writes to, ' +
      'starred, replied to, from the last 7 days, or not bulk mail). It changes nothing. ' +
      '`apply` archives the chosen groups of a plan; the user approves it on a card, every time. ' +
      '`undo` moves a plan’s archived mail back to the inbox, for 30 days. Nothing is ever deleted.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['plan', 'apply', 'undo'],
          description: 'plan, apply or undo.',
        },
        plan_id: {
          type: 'string',
          description: 'For apply and undo: the plan_id `plan` returned.',
        },
        groups: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For apply: the group ids to archive. Start from the plan’s `preselected`; leave out what the user wants to keep.',
        },
        max_messages: {
          type: 'number',
          description: `For plan: how many of the newest inbox emails to look at (default ${DEFAULT_SCAN}, at most ${MAX_SCAN}).`,
        },
      },
      required: ['action'],
    },
  },
};

/** Drop inbox_cleanup without the connector's move, and hide its primitives. */
export function adjustInboxCleanupTools(
  tools: ToolDefinition[],
): ToolDefinition[] {
  const names = new Set(tools.map((tool) => tool.function.name));
  const available = names.has(MOVE) && names.has(LIST_HEADERS);
  return tools.filter((tool) =>
    tool.function.name === INBOX_CLEANUP_TOOL
      ? available
      : !HIDDEN_TOOLS.has(tool.function.name),
  );
}

function plansDir(): string {
  return path.join(WORKSPACE_ROOT, '.hybridclaw', 'inbox-cleanup');
}

function planPath(id: string): string {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Unknown plan_id.');
  return path.join(plansDir(), `${id}.json`);
}

function readPlan(id: unknown): Plan {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('`plan_id` is required; run `plan` first.');
  }
  const file = planPath(id.trim());
  if (!fs.existsSync(file)) {
    throw new Error('Unknown plan_id; run `plan` again.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Plan;
}

function writePlan(plan: Plan): void {
  fs.mkdirSync(plansDir(), { recursive: true });
  const file = planPath(plan.id);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(plan));
  fs.renameSync(temp, file);
}

function pruneOldPlans(now: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(plansDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(plansDir(), entry);
    try {
      if (now - fs.statSync(file).mtimeMs > UNDO_TTL_MS + DAY_MS) {
        fs.rmSync(file);
      }
    } catch {
      // Another session pruned it first.
    }
  }
}

async function call<T>(
  mcp: McpCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await mcp.callToolDetailed(name, args);
  if (result.isError) throw new Error(result.output.replace(/^Error: /, ''));
  return JSON.parse(result.output) as T;
}

const ADDRESS = /[^\s<>,;"()]+@[^\s<>,;"()]+\.[^\s<>,;"()]+/g;

function addresses(value: string | null): string[] {
  return (value?.match(ADDRESS) ?? []).map((a) => a.toLowerCase());
}

// "Shop News <news@shop.test>" gives "Shop News"; apps show it as plain text.
function displayName(from: string | null, address: string): string {
  const name = from?.split('<')[0].replaceAll('"', '').trim();
  return name && !name.includes('@') ? name : address;
}

function isBulk(message: Header): boolean {
  const precedence = message.precedence?.toLowerCase() ?? '';
  const auto = message.auto_submitted?.toLowerCase() ?? '';
  return (
    Boolean(message.list_id) ||
    message.list_unsubscribe ||
    ['bulk', 'list', 'junk'].includes(precedence) ||
    (auto !== '' && auto !== 'no')
  );
}

function groupKey(message: Header, sender: string): string {
  const listId = message.list_id?.match(/<([^>]+)>/)?.[1] ?? message.list_id;
  return listId ? `list:${listId.toLowerCase()}` : `from:${sender}`;
}

async function sentRecipients(mcp: McpCaller): Promise<Set<string>> {
  const { folders } = await call<{
    folders: { name: string; role: string | null }[];
  }>(mcp, LIST_FOLDERS, {});
  const sent = folders.find((folder) => folder.role === 'sent');
  const people = new Set<string>();
  if (!sent) return people;
  let before: number | null = null;
  let seen = 0;
  do {
    const page: HeaderPage = await call<HeaderPage>(mcp, LIST_HEADERS, {
      folder: sent.name,
      limit: PAGE,
      ...(before ? { before_uid: before } : {}),
    });
    for (const message of page.messages) {
      for (const address of [
        ...addresses(message.to),
        ...addresses(message.cc),
      ]) {
        people.add(address);
      }
    }
    seen += page.messages.length;
    before = page.next_before_uid;
  } while (before && seen < SENT_SCAN);
  return people;
}

async function makePlan(
  mcp: McpCaller,
  args: Record<string, unknown>,
  now: number,
): Promise<Plan> {
  const requested = Number(args.max_messages);
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_SCAN)
      : DEFAULT_SCAN;
  const people = await sentRecipients(mcp);
  const messages: Header[] = [];
  let uidvalidity = 0;
  let inboxTotal = 0;
  let before: number | null = null;
  do {
    const page: HeaderPage = await call<HeaderPage>(mcp, LIST_HEADERS, {
      folder: 'INBOX',
      limit: Math.min(PAGE, limit - messages.length),
      ...(before ? { before_uid: before } : {}),
    });
    if (uidvalidity && page.uidvalidity !== uidvalidity) {
      throw new Error(
        'The inbox was reset on the mail server while I read it; try again.',
      );
    }
    uidvalidity = page.uidvalidity;
    inboxTotal ||= page.matched;
    messages.push(...page.messages);
    before = page.next_before_uid;
  } while (before && messages.length < limit);

  const kept: Protected = {
    starred: 0,
    replied: 0,
    people: 0,
    recent: 0,
    not_bulk: 0,
  };
  // A sender the user replied to, or writes to, is a person: keep all of it.
  const repliedSenders = new Set(
    messages
      .filter((m) => m.is_answered)
      .flatMap((m) => addresses(m.from).slice(0, 1)),
  );
  const byKey = new Map<string, Header[]>();
  for (const message of messages) {
    const sender = addresses(message.from)[0] ?? '';
    const sent = message.date ? Date.parse(message.date) : Number.NaN;
    const reason: keyof Protected | undefined = message.is_flagged
      ? 'starred'
      : repliedSenders.has(sender)
        ? 'replied'
        : people.has(sender)
          ? 'people'
          : !Number.isFinite(sent) || now - sent < RECENT_DAYS * DAY_MS
            ? 'recent'
            : !sender || !isBulk(message)
              ? 'not_bulk'
              : undefined;
    if (reason) {
      kept[reason] += 1;
      continue;
    }
    const key = groupKey(message, sender);
    byKey.set(key, [...(byKey.get(key) ?? []), message]);
  }

  const groups = [...byKey.values()]
    .filter((members) => members.length >= MIN_GROUP)
    .sort((a, b) => b.length - a.length)
    .map((members, index): Group => {
      const newest = members.reduce((a, b) => (a.uid > b.uid ? a : b));
      const oldest = members.reduce((a, b) => (a.uid < b.uid ? a : b));
      const sender = addresses(newest.from)[0] ?? '';
      return {
        id: `g${index + 1}`,
        name: displayName(newest.from, sender),
        sender,
        list_id: newest.list_id,
        count: members.length,
        unread: members.filter((m) => m.is_unread).length,
        newest: newest.date,
        oldest: oldest.date,
        samples: [...members]
          .sort((a, b) => b.uid - a.uid)
          .map((m) => m.subject ?? '')
          .filter(Boolean)
          .slice(0, 3),
        sure:
          members.length >= SURE_GROUP &&
          members.every((m) => Boolean(m.list_id) || m.list_unsubscribe),
        uids: members.map((m) => m.uid).sort((a, b) => a - b),
      };
    });
  // Single bulk messages and their senders stay in the inbox too.
  for (const members of byKey.values()) {
    if (members.length < MIN_GROUP) kept.not_bulk += members.length;
  }
  return {
    version: 1,
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    created_at: new Date(now).toISOString(),
    folder: 'INBOX',
    uidvalidity,
    inbox_total: inboxTotal,
    looked_at: messages.length,
    groups,
    protected: kept,
  };
}

function planSummary(plan: Plan): Record<string, unknown> {
  const archivable = plan.groups.reduce((sum, g) => sum + g.count, 0);
  return {
    plan_id: plan.id,
    inbox_total: plan.inbox_total,
    looked_at: plan.looked_at,
    archivable,
    group_count: plan.groups.length,
    groups: plan.groups.slice(0, SHOWN_GROUPS).map((g) => ({
      id: g.id,
      name: g.name,
      sender: g.sender,
      count: g.count,
      unread: g.unread,
      newest: g.newest,
      sure: g.sure,
      samples: g.samples,
    })),
    more_groups: Math.max(0, plan.groups.length - SHOWN_GROUPS),
    preselected: plan.groups.filter((g) => g.sure).map((g) => g.id),
    left_alone: plan.protected,
    expires_at: new Date(
      Date.parse(plan.created_at) + PLAN_TTL_MS,
    ).toISOString(),
  };
}

function chosenGroups(plan: Plan, value: unknown): Group[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('`groups` must list the group ids to archive.');
  }
  const ids = new Set(value.map(String));
  const chosen = plan.groups.filter((g) => ids.has(g.id));
  const unknown = [...ids].filter(
    (id) => !plan.groups.some((g) => g.id === id),
  );
  if (unknown.length) {
    throw new Error(`Plan ${plan.id} has no group ${unknown.join(', ')}.`);
  }
  return chosen;
}

function chunks(uids: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < uids.length; i += PAGE) out.push(uids.slice(i, i + PAGE));
  return out;
}

interface MoveResult {
  to_folder: string;
  to_uidvalidity: number | null;
  moved: [number, number | null][];
  skipped: { uid: number; reason: string }[];
}

function addSkipped(
  into: Record<string, number>,
  skipped: MoveResult['skipped'],
): void {
  for (const item of skipped) into[item.reason] = (into[item.reason] ?? 0) + 1;
}

async function applyPlan(
  mcp: McpCaller,
  plan: Plan,
  groups: Group[],
  now: number,
): Promise<Record<string, unknown>> {
  if (plan.receipt) {
    throw new Error(
      `Plan ${plan.id} was already applied; run \`plan\` for a new one.`,
    );
  }
  if (now - Date.parse(plan.created_at) > PLAN_TTL_MS) {
    throw new Error(`Plan ${plan.id} is over a day old; run \`plan\` again.`);
  }
  const receipt: Receipt = {
    applied_at: new Date(now).toISOString(),
    groups: groups.map((g) => g.id),
    archive_folder: null,
    archive_uidvalidity: null,
    moved: [],
    skipped: {},
  };
  plan.receipt = receipt;
  const uids = groups.flatMap((g) => g.uids).sort((a, b) => a - b);
  try {
    for (const batch of chunks(uids)) {
      const result = await call<MoveResult>(mcp, MOVE, {
        folder: plan.folder,
        uidvalidity: plan.uidvalidity,
        uids: batch,
        to: 'archive',
      });
      receipt.archive_folder = result.to_folder;
      receipt.archive_uidvalidity =
        result.to_uidvalidity ?? receipt.archive_uidvalidity;
      receipt.moved.push(...result.moved);
      addSkipped(receipt.skipped, result.skipped);
      // Saved after every batch: an interrupted run still undoes what moved.
      writePlan(plan);
    }
  } catch (err) {
    receipt.error = err instanceof Error ? err.message : String(err);
  }
  writePlan(plan);
  return {
    plan_id: plan.id,
    archived: receipt.moved.length,
    to_folder: receipt.archive_folder,
    skipped: receipt.skipped,
    not_moved: uids.length - receipt.moved.length,
    ...(receipt.error ? { stopped_because: receipt.error } : {}),
    undo_until: new Date(now + UNDO_TTL_MS).toISOString(),
  };
}

async function undoPlan(
  mcp: McpCaller,
  plan: Plan,
  now: number,
): Promise<Record<string, unknown>> {
  const receipt = plan.receipt;
  if (!receipt || receipt.moved.length === 0) {
    throw new Error(`Plan ${plan.id} archived nothing, so there is no undo.`);
  }
  if (receipt.undone_at) {
    throw new Error(`Plan ${plan.id} was already undone.`);
  }
  if (now - Date.parse(receipt.applied_at) > UNDO_TTL_MS) {
    throw new Error(
      `Plan ${plan.id} is over 30 days old; its mail is still in ${receipt.archive_folder}.`,
    );
  }
  if (!receipt.archive_folder || !receipt.archive_uidvalidity) {
    throw new Error(
      'The mail server did not say where the archived mail landed, so it cannot be moved back automatically.',
    );
  }
  const archived = receipt.moved
    .map(([, dst]) => dst)
    .filter((uid): uid is number => typeof uid === 'number')
    .sort((a, b) => a - b);
  const skipped: Record<string, number> = {};
  let restored = 0;
  for (const batch of chunks(archived)) {
    const result = await call<MoveResult>(mcp, MOVE, {
      folder: receipt.archive_folder,
      uidvalidity: receipt.archive_uidvalidity,
      uids: batch,
      to: 'inbox',
    });
    restored += result.moved.length;
    addSkipped(skipped, result.skipped);
  }
  receipt.undone_at = new Date(now).toISOString();
  receipt.undo_skipped = skipped;
  writePlan(plan);
  return {
    plan_id: plan.id,
    back_in_inbox: restored,
    not_found: receipt.moved.length - restored,
    skipped,
  };
}

export async function runInboxCleanup(
  args: Record<string, unknown>,
  mcp: McpCaller | null,
  now = Date.now(),
): Promise<string> {
  if (!mcp?.isKnownTool(MOVE) || !mcp.isKnownTool(LIST_HEADERS)) {
    throw new Error(
      'No mailbox is connected that supports clean-up. The user can connect one in Connectors.',
    );
  }
  pruneOldPlans(now);
  switch (args.action) {
    case 'plan': {
      const plan = await makePlan(mcp, args, now);
      writePlan(plan);
      return JSON.stringify(planSummary(plan));
    }
    case 'apply': {
      const plan = readPlan(args.plan_id);
      const result = await applyPlan(
        mcp,
        plan,
        chosenGroups(plan, args.groups),
        now,
      );
      return JSON.stringify(result);
    }
    case 'undo':
      return JSON.stringify(await undoPlan(mcp, readPlan(args.plan_id), now));
    default:
      throw new Error('`action` must be plan, apply or undo.');
  }
}

/** The facts the app's clean-up card shows for an `apply` approval. */
export function inboxCleanupReview(argsJson: string): string | undefined {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    if (args.action !== 'apply') return undefined;
    const plan = readPlan(args.plan_id);
    const groups = chosenGroups(plan, args.groups);
    return JSON.stringify({
      kind: 'inbox_cleanup',
      plan_id: plan.id,
      total: groups.reduce((sum, g) => sum + g.count, 0),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        sender: g.sender,
        count: g.count,
        unread: g.unread,
        samples: g.samples,
      })),
      left_alone: plan.protected,
    });
  } catch {
    return undefined;
  }
}

function applySummary(args: Record<string, unknown>): string {
  try {
    const plan = readPlan(args.plan_id);
    const groups = chosenGroups(plan, args.groups);
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    const senders = groups.length === 1 ? 'sender' : 'senders';
    return `archive ${total} emails from ${groups.length} ${senders}`;
  } catch {
    return 'archive emails from your inbox';
  }
}

/**
 * Approval tiers for inbox_cleanup, and for the connector's move when the model
 * calls it itself: that one is refused, so every move goes through a plan.
 */
export function classifyInboxCleanup(
  toolName: string,
  args: Record<string, unknown>,
): ClassifiedAction | undefined {
  const base = {
    pathHints: [],
    hostHints: [],
    promotableRed: false,
  };
  if (MOVE_TOOL.test(toolName)) {
    return {
      ...base,
      tier: 'red',
      actionKey: `mcp:${toolName}`,
      intent: 'move emails in your mailbox outside a clean-up plan',
      consequenceIfDenied:
        'Nothing moves. I use inbox_cleanup, which shows you the plan first.',
      reason: 'mail is moved only through an inbox_cleanup plan you approve',
      commandPreview: '',
      writeIntent: true,
      stickyYellow: true,
      hardDeny: true,
    };
  }
  if (toolName !== INBOX_CLEANUP_TOOL) return undefined;
  if (args.action === 'plan') {
    return {
      ...base,
      tier: 'green',
      actionKey: `${INBOX_CLEANUP_TOOL}:plan`,
      intent: 'look through your inbox by sender to plan a clean-up',
      consequenceIfDenied: 'I will leave your inbox as it is.',
      reason: 'this reads mail headers only and changes nothing',
      commandPreview: '',
      writeIntent: false,
      stickyYellow: false,
    };
  }
  if (args.action === 'apply') {
    const summary = applySummary(args);
    // Owner call, 2026-10-09: a bulk change to the user's mailbox asks every
    // time, in every mode, after Muse deleted 15,200 emails under a standing rule.
    return {
      ...base,
      tier: 'red',
      actionKey: `${INBOX_CLEANUP_TOOL}:apply`,
      intent: summary,
      consequenceIfDenied: 'Nothing moves; your inbox stays as it is.',
      reason:
        'this moves many emails out of your inbox (to Archive, not deleted)',
      commandPreview: summary,
      writeIntent: true,
      stickyYellow: true,
      explicitApprovalRequired: true,
      pinned: true,
    };
  }
  return {
    ...base,
    tier: 'yellow',
    actionKey: `${INBOX_CLEANUP_TOOL}:undo`,
    intent: 'move the mail a clean-up archived back to your inbox',
    consequenceIfDenied: 'The archived mail stays in Archive.',
    reason: 'this moves mail back where it was',
    commandPreview: String(args.plan_id ?? ''),
    writeIntent: true,
    stickyYellow: false,
  };
}
