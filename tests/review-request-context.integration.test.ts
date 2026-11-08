import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  encodeSteerNote,
  steerInboxDirName,
} from '../container/shared/steer-inbox.js';
import type { PendingApproval } from '../container/src/pending-approval-store.js';
import { normalizeMessageContentToText } from '../container/src/ralph.js';
import type { ChatMessage } from '../container/src/types.js';
import { SteerInbox } from '../src/infra/steer-inbox.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

function storedRequest(dir: string): string {
  const store = JSON.parse(
    fs.readFileSync(
      path.join(dir, '.hybridclaw/pending-approvals.json'),
      'utf8',
    ),
  ) as { pending: PendingApproval[] };
  expect(store.pending).toHaveLength(1);
  return store.pending[0].originalPrompt;
}

function tool(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

const intro = 'Read the local configuration.';
const tail = 'Keep report.md unchanged.';
const background = 'Synthetic background context.\n'.repeat(90);
test.each([
  { name: 'short control', content: intro, expected: intro },
  {
    name: 'long trailing constraint',
    content: `${intro}\n\n${background}\n${tail}`,
    expected: `${intro}\n\n${background}\n${tail}`,
  },
  {
    name: 'internal layout',
    content: `${intro}\n\n  ${tail}`,
    expected: `${intro}\n\n  ${tail}`,
  },
  {
    name: 'multipart request',
    content: [
      { type: 'text' as const, text: intro },
      { type: 'text' as const, text: background + tail },
    ],
    expected: `${intro}\n${background}${tail}`,
  },
])(
  'approval and worker replay preserve $name',
  async ({ content, expected }) => {
    let step = 0;
    let replay = '';
    const run = await runAgent(
      async (body) => {
        if (step++ === 0) return tool('read-config', 'read', { path: '.env' });
        replay = normalizeMessageContentToText(
          body.messages.filter((message) => message.role === 'user').at(-1)
            ?.content ?? null,
        );
        return { role: 'assistant', content: 'Done.' };
      },
      {
        approvalMode: 'full',
        approvalUserId: 'user-a',
        messages: [{ role: 'user', content }],
      },
      { '.env': 'EXAMPLE=fixture\n', 'report.md': 'Keep this report.\n' },
    );
    const approvalId = run.output.pendingApproval?.approvalId;
    expect(approvalId).toBeTruthy();
    expect.soft(storedRequest(run.dir)).toBe(expected);
    const answer = `yes ${approvalId}`;
    const resumed = await run.followup({
      approvalUserText: answer,
      messages: [{ role: 'user', content: answer }],
    });
    expect(replay).toContain(expected);
    expect(resumed.pendingApproval).toBeUndefined();
    expect(
      resumed.toolExecutions?.filter((entry) => entry.name === 'read'),
    ).toHaveLength(1);
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      'Keep this report.\n',
    );
    const next = await run.followup({
      approvalUserText: 'Finish.',
      messages: [{ role: 'user', content: 'Finish.' }],
    });
    expect(
      next.toolExecutions?.filter((entry) => entry.name === 'read') ?? [],
    ).toEqual([]);
  },
  20_000,
);

test.each([true, false])(
  'only verified, shown steering reaches a later tool approval: %s',
  async (verified) => {
    const requestId = 'review-context';
    const inbox = new SteerInbox();
    const notes = ['Keep the report unchanged.', 'Use concise output.'];
    const history: ChatMessage[][] = [];
    let step = 0;
    let dir = '';
    let secret = '';
    const run = await runAgent(
      async (body) => {
        history.push(body.messages);
        const current = step++;
        if (verified && current < notes.length)
          expect(inbox.deliver(notes[current])).toBe(true);
        if (!verified && current === 0) {
          const folder = path.join(dir, 'ipc', steerInboxDirName(requestId));
          fs.writeFileSync(
            path.join(folder, '0000-unsigned.json'),
            JSON.stringify({ requestId, id: 'unsigned', content: notes[0] }),
          );
          fs.writeFileSync(
            path.join(folder, '0001-wrong-request.json'),
            encodeSteerNote(secret, {
              requestId: 'old-request',
              id: 'old',
              content: notes[1],
            }),
          );
        }
        if (current === 0)
          return tool('collision', 'write', {
            path: 'report.md',
            contents: 'New report',
          });
        if (current === 1)
          return tool('inspect', 'read', { path: 'report.md' });
        return tool('read-config', 'read', { path: '.env' });
      },
      {
        requestId,
        approvalMode: 'full',
        messages: [{ role: 'user', content: intro }],
      },
      { '.env': 'EXAMPLE=fixture\n', 'report.md': 'Existing report\n' },
      {
        prepare: async (workspace, authSecret) => {
          dir = workspace;
          secret = authSecret;
          inbox.open({ ipcDir: path.join(dir, 'ipc'), requestId, authSecret });
          return {};
        },
      },
    );
    expect(run.output.pendingApproval?.toolName).toBe('read');
    const prompt = storedRequest(run.dir);
    expect(prompt).toContain(intro);
    const shown = history
      .flat()
      .filter((message) => message.role === 'user')
      .map((message) => normalizeMessageContentToText(message.content))
      .join('\n');
    for (const note of notes) {
      if (verified) {
        expect(shown).toContain(note);
        expect(prompt).toContain(note);
      } else {
        expect(shown).not.toContain(note);
        expect(prompt).not.toContain(note);
      }
    }
    if (verified)
      expect(prompt.indexOf(notes[0])).toBeLessThan(prompt.indexOf(notes[1]));
    expect(inbox.shownNotes(run.output.steerNoteIds)).toEqual(
      verified ? notes : [],
    );
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      'Existing report\n',
    );
  },
  20_000,
);
