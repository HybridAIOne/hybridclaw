import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ToolDefinition } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-inbox-cleanup-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

const NOW = Date.parse('2026-10-09T12:00:00Z');
const OLD = 'Thu, 10 Sep 2026 09:00:00 +0200';
const THIS_WEEK = 'Wed, 07 Oct 2026 09:00:00 +0200';

interface Mail {
  uid: number;
  from: string;
  to?: string;
  subject: string;
  date?: string;
  list_id?: string;
  list_unsubscribe?: boolean;
  precedence?: string;
  is_flagged?: boolean;
  is_answered?: boolean;
}

/** An IMAP mailbox as the connector's three tools show it. */
class FakeMailbox {
  folders: Record<string, { validity: number; mail: Mail[] }> = {
    INBOX: { validity: 42, mail: [] },
    Gesendet: { validity: 5, mail: [] },
    Archiv: { validity: 77, mail: [] },
  };
  moves: Record<string, unknown>[] = [];
  private nextUid = 500;

  isKnownTool = (name: string) => name.startsWith('hybridai__mailbox__');

  callToolDetailed = vi.fn(
    async (name: string, args: Record<string, unknown>) => {
      const output = this.answer(name.replace('hybridai__mailbox__', ''), args);
      return { output: JSON.stringify(output), isError: false };
    },
  );

  private answer(tool: string, args: Record<string, unknown>): unknown {
    if (tool === 'list_folders') {
      return {
        folders: [
          { name: 'INBOX', role: 'inbox' },
          { name: 'Gesendet', role: 'sent' },
          { name: 'Archiv', role: 'archive' },
        ],
      };
    }
    if (tool === 'list_message_headers') {
      const folder = this.folders[String(args.folder)];
      const before = Number(args.before_uid ?? Number.MAX_SAFE_INTEGER);
      const all = folder.mail
        .filter((m) => m.uid < before)
        .sort((a, b) => b.uid - a.uid);
      const page = all.slice(0, Number(args.limit));
      return {
        uidvalidity: folder.validity,
        matched: all.length,
        messages: page.map((m) => ({
          uid: m.uid,
          from: m.from,
          to: m.to ?? 'max@gmx.de',
          cc: null,
          subject: m.subject,
          date: m.date ? new Date(m.date).toISOString() : null,
          list_id: m.list_id ?? null,
          list_unsubscribe: m.list_unsubscribe ?? false,
          precedence: m.precedence ?? null,
          auto_submitted: null,
          is_unread: true,
          is_flagged: m.is_flagged ?? false,
          is_answered: m.is_answered ?? false,
        })),
        next_before_uid: all.length > page.length ? page.at(-1)?.uid : null,
      };
    }
    if (tool === 'move_messages') {
      this.moves.push(args);
      const from = this.folders[String(args.folder)];
      const toName = args.to === 'archive' ? 'Archiv' : 'INBOX';
      const to = this.folders[toName];
      const moved: [number, number][] = [];
      for (const uid of args.uids as number[]) {
        const index = from.mail.findIndex((m) => m.uid === uid);
        if (index < 0) continue;
        const [mail] = from.mail.splice(index, 1);
        const copy = { ...mail, uid: this.nextUid++ };
        to.mail.push(copy);
        moved.push([uid, copy.uid]);
      }
      return {
        from_folder: args.folder,
        to_folder: toName,
        to_uidvalidity: to.validity,
        moved,
        skipped: [],
      };
    }
    throw new Error(`unexpected tool ${tool}`);
  }
}

function newsletter(uid: number, extra: Partial<Mail> = {}): Mail {
  return {
    uid,
    from: 'Shop News <news@shop.test>',
    subject: `Deals of week ${uid}`,
    date: OLD,
    list_id: 'Shop <news.shop.test>',
    list_unsubscribe: true,
    ...extra,
  };
}

// A known incident: a keyword sorter counted "offer" as marketing and deleted
// contract negotiations. Here the inbox holds the same kind of mail.
function seed(mailbox: FakeMailbox): void {
  mailbox.folders.Gesendet.mail = [
    {
      uid: 1,
      from: 'max@gmx.de',
      to: 'Kanzlei Weber <weber@kanzlei.test>',
      subject: 'Re: Vertrag',
      date: OLD,
    },
  ];
  mailbox.folders.INBOX.mail = [
    ...[10, 11, 12, 13, 14, 15].map((uid) => newsletter(uid)),
    newsletter(16, { is_flagged: true }),
    newsletter(17, { date: THIS_WEEK }),
    {
      uid: 20,
      from: 'Promo <promo@deals.test>',
      subject: 'Your offer inside',
      date: OLD,
      precedence: 'bulk',
    },
    {
      uid: 21,
      from: 'Promo <promo@deals.test>',
      subject: 'Last offer',
      date: OLD,
      precedence: 'bulk',
    },
    // A person writing about an offer: no bulk headers.
    {
      uid: 30,
      from: 'Anna <anna@example.com>',
      subject: 'The offer, signed',
      date: OLD,
    },
    // A firm the user writes to, sent through a mailing tool.
    {
      uid: 31,
      from: 'Kanzlei Weber <weber@kanzlei.test>',
      subject: 'Offer for the film agreement',
      date: OLD,
      list_unsubscribe: true,
    },
    {
      uid: 32,
      from: 'Kanzlei Weber <weber@kanzlei.test>',
      subject: 'Second offer',
      date: OLD,
      list_unsubscribe: true,
    },
    // A newsletter the user answered once: its sender is a person to them.
    {
      uid: 40,
      from: 'Club <hello@club.test>',
      subject: 'Meet-up',
      date: OLD,
      list_unsubscribe: true,
      is_answered: true,
    },
    {
      uid: 41,
      from: 'Club <hello@club.test>',
      subject: 'Next meet-up',
      date: OLD,
      list_unsubscribe: true,
    },
  ];
}

async function setup(now = NOW) {
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', makeTempDir());
  vi.useFakeTimers({ now, toFake: ['Date'] });
  const tools = await import('../container/src/tools.js');
  const cleanup = await import('../container/src/tools/inbox-cleanup.js');
  const mailbox = new FakeMailbox();
  seed(mailbox);
  tools.setMcpClientManager(mailbox as never);
  async function run(args: Record<string, unknown>) {
    const result = await tools.executeToolWithMetadata(
      'inbox_cleanup',
      JSON.stringify(args),
    );
    return { ...result, json: result.isError ? null : JSON.parse(result.output) };
  }
  return { tools, cleanup, mailbox, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('inbox_cleanup', () => {
  test('plans by sender and headers and leaves people, stars and this week alone', async () => {
    const { run, mailbox } = await setup();

    const { json: plan } = await run({ action: 'plan' });

    expect(plan.groups).toEqual([
      expect.objectContaining({
        id: 'g1',
        name: 'Shop News',
        sender: 'news@shop.test',
        count: 6,
        sure: true,
      }),
      expect.objectContaining({
        id: 'g2',
        name: 'Promo',
        count: 2,
        sure: false,
        samples: ['Last offer', 'Your offer inside'],
      }),
    ]);
    expect(plan.preselected).toEqual(['g1']);
    expect(plan.archivable).toBe(8);
    expect(plan.left_alone).toEqual({
      starred: 1,
      replied: 2,
      people: 2,
      recent: 1,
      not_bulk: 1,
    });
    // Planning reads; it never moves.
    expect(mailbox.moves).toEqual([]);
    expect(mailbox.folders.INBOX.mail).toHaveLength(15);
  });

  test('apply archives exactly the planned uids, and undo brings them back', async () => {
    const { run, mailbox } = await setup();
    const { json: plan } = await run({ action: 'plan' });
    // Mail that arrives after the plan is not part of it.
    mailbox.folders.INBOX.mail.push(newsletter(99));

    const { json: applied } = await run({
      action: 'apply',
      plan_id: plan.plan_id,
      groups: ['g1', 'g2'],
    });

    expect(mailbox.moves).toEqual([
      {
        folder: 'INBOX',
        uidvalidity: 42,
        uids: [10, 11, 12, 13, 14, 15, 20, 21],
        to: 'archive',
      },
    ]);
    expect(applied).toMatchObject({
      archived: 8,
      to_folder: 'Archiv',
      not_moved: 0,
    });
    expect(mailbox.folders.INBOX.mail.map((m) => m.uid).sort()).toEqual([
      16, 17, 30, 31, 32, 40, 41, 99,
    ]);

    const again = await run({
      action: 'apply',
      plan_id: plan.plan_id,
      groups: ['g1'],
    });
    expect(again.isError).toBe(true);
    expect(again.output).toContain('already applied');

    const { json: undone } = await run({
      action: 'undo',
      plan_id: plan.plan_id,
    });

    expect(undone).toMatchObject({ back_in_inbox: 8, not_found: 0 });
    expect(mailbox.moves.at(-1)).toEqual({
      folder: 'Archiv',
      uidvalidity: 77,
      uids: [500, 501, 502, 503, 504, 505, 506, 507],
      to: 'inbox',
    });
    expect(mailbox.folders.Archiv.mail).toEqual([]);
  });

  test('a plan file outside the agent’s reach holds the uids, and old plans expire', async () => {
    const { run, mailbox } = await setup();
    const { json: plan } = await run({ action: 'plan' });
    const file = path.join(
      process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT ?? '',
      '.hybridclaw',
      'inbox-cleanup',
      `${plan.plan_id}.json`,
    );
    expect(fs.existsSync(file)).toBe(true);

    vi.setSystemTime(NOW + 25 * 3600_000);
    const late = await run({
      action: 'apply',
      plan_id: plan.plan_id,
      groups: ['g1'],
    });
    expect(late.output).toContain('over a day old');

    const unknown = await run({
      action: 'apply',
      plan_id: '../../etc',
      groups: ['g1'],
    });
    expect(unknown.output).toContain('Unknown plan_id');
    expect(mailbox.moves).toEqual([]);
  });

  test('the approval card gets the groups from the plan, not from the model', async () => {
    const { run, cleanup } = await setup();
    const { json: plan } = await run({ action: 'plan' });

    const review = JSON.parse(
      cleanup.inboxCleanupReview(
        JSON.stringify({
          action: 'apply',
          plan_id: plan.plan_id,
          groups: ['g1'],
        }),
      ) ?? 'null',
    );

    expect(review).toMatchObject({
      kind: 'inbox_cleanup',
      total: 6,
      groups: [{ id: 'g1', name: 'Shop News', count: 6 }],
      left_alone: { people: 2 },
    });
  });

  test('the tool shows only with the mailbox connector, which hides its primitives', async () => {
    const { cleanup, tools } = await setup();
    const named = (...names: string[]): ToolDefinition[] =>
      names.map((name) => ({
        type: 'function',
        function: { name, description: '', parameters: { type: 'object' } },
      }));
    const definition = tools.TOOL_DEFINITIONS.filter(
      (tool) => tool.function.name === 'inbox_cleanup',
    );

    expect(
      cleanup
        .adjustInboxCleanupTools([
          ...definition,
          ...named(
            'hybridai__mailbox__list_messages',
            'hybridai__mailbox__list_message_headers',
            'hybridai__mailbox__move_messages',
          ),
        ])
        .map((tool) => tool.function.name),
    ).toEqual(['inbox_cleanup', 'hybridai__mailbox__list_messages']);
    expect(
      cleanup
        .adjustInboxCleanupTools([
          ...definition,
          ...named('hybridai__mailbox__list_messages'),
        ])
        .map((tool) => tool.function.name),
    ).toEqual(['hybridai__mailbox__list_messages']);
  });
});
