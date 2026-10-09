import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';
import { writeZipArchive } from './helpers/zip-archive.js';
import { useTempDir } from './test-utils.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-import-command-',
});
const makeTempDir = useTempDir();

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { resolveTextChannelSlashCommands } = await import(
    '../src/gateway/text-channel-commands.ts'
  );
  const { createUploadedMediaContextItem } = await import(
    '../src/media/uploaded-media-cache.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  initDatabase({ quiet: true });

  const upload = (name: string, content: Buffer | string, mimeType: string) =>
    createUploadedMediaContextItem({
      attachmentName: name,
      buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
      mimeType,
    });

  // As a web chat turn arrives: parsed from the text, then dispatched.
  const send = async (
    text: string,
    media: Awaited<ReturnType<typeof upload>>[] = [],
  ) => {
    const parsed = resolveTextChannelSlashCommands(text);
    expect(parsed).not.toBeNull();
    const result = await handleGatewayCommand({
      sessionId: 'app-main',
      guildId: null,
      channelId: 'web',
      args: parsed?.[0] ?? [],
      media,
      userId: 'user_a',
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { ...result, json };
  };
  const imports = () => path.join(agentWorkspaceDir('main'), 'imports');
  return { send, upload, imports };
}

const chatGptConversations = [
  {
    title: 'Lisbon trip',
    create_time: 1_780_000_000,
    update_time: 1_790_000_000,
    current_node: 'c',
    mapping: {
      root: { id: 'root', message: null, parent: null },
      ctx: {
        id: 'ctx',
        parent: 'root',
        message: {
          author: { role: 'user' },
          content: {
            content_type: 'user_editable_context',
            user_profile: 'I am Ben, a data scientist in Munich.',
            user_instructions: 'Keep answers short.',
          },
        },
      },
      a: {
        id: 'a',
        parent: 'ctx',
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['Plan  three days\nin Lisbon'] },
        },
      },
      edited: {
        id: 'edited',
        parent: 'a',
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['An abandoned edit'] },
        },
      },
      b: {
        id: 'b',
        parent: 'a',
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Day one: Alfama'] },
        },
      },
      c: {
        id: 'c',
        parent: 'b',
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['My daughter is 7'] },
        },
      },
    },
  },
  {
    title: 'Older',
    create_time: 1_700_000_000,
    current_node: 'x',
    mapping: {
      x: {
        id: 'x',
        parent: null,
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['I run on Sundays'] },
        },
      },
    },
  },
];

test('ChatGPT export: the branch the user saw, their messages only, newest first', async () => {
  const { chatGptExport, renderConversationDigest } = await import(
    '../src/gateway/import-command.ts'
  );
  const chat = chatGptExport(chatGptConversations);
  expect(chat.profile).toEqual([
    'I am Ben, a data scientist in Munich.',
    'Keep answers short.',
  ]);
  expect(chat.conversations[0]?.messages).toEqual([
    'Plan  three days\nin Lisbon',
    'My daughter is 7',
  ]);

  const digest = renderConversationDigest('ChatGPT', chat);
  expect(digest).toMatchObject({ kept: 2, omitted: 0 });
  expect(digest.markdown).toContain('- Plan three days in Lisbon\n');
  expect(digest.markdown).not.toContain('Alfama');
  expect(digest.markdown).not.toContain('abandoned');
  expect(digest.markdown.indexOf('Lisbon trip')).toBeLessThan(
    digest.markdown.indexOf('Older'),
  );

  // Too long for all: the newest conversations stay, the count says so.
  const short = renderConversationDigest('ChatGPT', chat, 200);
  expect(short).toMatchObject({ kept: 1, omitted: 1 });
  expect(short.markdown).toContain('1 of 2 conversations');
});

test('Claude export: human messages and project setup', async () => {
  const { claudeExport, claudeProjects } = await import(
    '../src/gateway/import-command.ts'
  );
  const chat = claudeExport([
    {
      name: 'Garden',
      created_at: '2026-05-01T10:00:00Z',
      chat_messages: [
        { sender: 'human', text: 'I grow tomatoes', content: [] },
        { sender: 'assistant', text: 'Nice' },
        {
          sender: 'human',
          text: '',
          content: [{ type: 'text', text: 'On a balcony' }],
        },
      ],
    },
  ]);
  expect(chat.conversations).toEqual([
    {
      title: 'Garden',
      time: Date.parse('2026-05-01T10:00:00Z'),
      messages: ['I grow tomatoes', 'On a balcony'],
    },
  ]);
  expect(
    claudeProjects([
      { name: 'Thesis', description: 'My PhD on soil', prompt_template: '' },
      { name: 'Empty' },
    ]),
  ).toEqual(['Thesis: My PhD on soil']);
});

test('an app stages a ChatGPT export and pasted text, then hands them to the agent', async () => {
  const { send, upload, imports } = await load();
  const zipPath = path.join(makeTempDir('hybridclaw-import-zip-'), 'x.zip');
  await writeZipArchive(zipPath, [
    {
      name: 'personal/conversations/conversations.json',
      content: JSON.stringify(chatGptConversations),
    },
    { name: 'user.json', content: '{"email":"ben@example.com"}' },
    { name: 'chat.html', content: '<html></html>' },
    { name: 'images/a.png', content: Buffer.from([1, 2, 3]) },
  ]);

  const staged = await send('/import chatgpt --json', [
    await upload('export.zip', fs.readFileSync(zipPath), 'application/zip'),
    await upload('chatgpt-memory.md', '- Likes jazz\n', 'text/markdown'),
  ]);
  expect(staged.json).toMatchObject({
    version: 1,
    source: 'chatgpt',
    files: ['conversations.md', '2/chatgpt-memory.md'],
    conversations: 2,
    omitted: 0,
  });
  const id = String(staged.json.id);
  expect(id).toMatch(/^chatgpt-\d{8}-\d{6}$/);
  const folder = path.join(imports(), id);
  expect(fs.readFileSync(path.join(folder, 'conversations.md'), 'utf-8')).toContain(
    'I am Ben, a data scientist in Munich.',
  );
  // Account data and pictures stay out of the workspace.
  expect(fs.existsSync(path.join(folder, 'user.json'))).toBe(false);
  expect(fs.readdirSync(folder).sort()).toEqual(['2', 'conversations.md']);

  const review = await send(`/import review ${id}`);
  expect(review.kind).toBe('plain');
  expect(review.continueWith?.content).toBe(
    'Import what ChatGPT knows about me.',
  );
  expect(review.continueWith?.instructions).toContain(
    `\`imports/${id}/conversations.md\`: their own messages in ChatGPT`,
  );
  expect(review.continueWith?.instructions).toContain(
    `\`imports/${id}/2/chatgpt-memory.md\``,
  );
});

test('OpenClaw keeps its notes and leaves its settings and skills behind', async () => {
  const { send, upload, imports } = await load();
  const zipPath = path.join(makeTempDir('hybridclaw-import-zip-'), 'x.zip');
  await writeZipArchive(zipPath, [
    { name: 'workspace/MEMORY.md', content: '- Ben likes jazz\n' },
    { name: 'workspace/USER.md', content: '- **Name:** Ben\n' },
    { name: 'workspace/memory/2026-09-01.md', content: 'Ran 10k' },
    { name: 'workspace/skills/x/SKILL.md', content: 'skill' },
    { name: 'openclaw.json', content: '{"apiKey":"secret"}' },
    { name: '.env', content: 'KEY=secret' },
  ]);
  const staged = await send('/import openclaw --json', [
    await upload('openclaw.zip', fs.readFileSync(zipPath), 'application/zip'),
  ]);
  expect(staged.json.files).toEqual([
    'workspace/MEMORY.md',
    'workspace/USER.md',
    'workspace/memory/2026-09-01.md',
  ]);
  const review = await send(`/import review ${staged.json.id} --json`);
  expect(review.continueWith?.content).toBe('Import my memory from OpenClaw.');
  expect(
    fs.existsSync(path.join(imports(), String(staged.json.id), 'openclaw.json')),
  ).toBe(false);
});

test('mistakes answer in JSON, and nothing is staged', async () => {
  const { send, upload, imports } = await load();
  expect((await send('/import chatgpt --json')).json).toEqual({
    version: 1,
    error: 'no-files',
  });
  expect((await send('/import myspace --json')).json).toEqual({
    version: 1,
    error: 'unknown-source',
  });
  expect(
    (
      await send('/import claude --json', [
        await upload('broken.zip', 'not a zip', 'application/zip'),
      ])
    ).json,
  ).toEqual({ version: 1, error: 'unreadable' });
  expect(
    (
      await send('/import hermes --json', [
        await upload('photo.json', '{}', 'application/json'),
      ])
    ).json,
  ).toEqual({ version: 1, error: 'nothing-found' });
  expect((await send('/import review chatgpt-20260101-000000 --json')).json).toEqual({
    version: 1,
    error: 'unknown-import',
  });
  // A path in place of an id is refused before the disk is looked at.
  const escape = await send('/import review ../../etc');
  expect(escape.kind).toBe('error');
  expect(escape.continueWith).toBeUndefined();
  expect(fs.existsSync(imports())).toBe(false);

  // Without --json, a person reads plain text.
  expect((await send('/import')).kind).toBe('error');
});

test('/help lists the command, so apps can tell it is there', async () => {
  const { send } = await load();
  expect((await send('/help')).text).toContain('`/import`');
});
