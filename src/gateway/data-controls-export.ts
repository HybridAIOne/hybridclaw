/**
 * A copy of what this instance keeps for its owner, as one ZIP: every stored
 * chat (all channels, archived ones too), the memory inventory, the visible
 * documents of each agent workspace, and, when the instance is signed in to
 * HybridAI, the account profile and improvement choice. Hidden, credential and
 * runtime files stay out, as in the phone's file browser. Built in memory and
 * refused with 413 above the size the phone accepts.
 */
import * as yazl from 'yazl';
import {
  getHybridAIApiKey,
  getHybridAIAuthStatus,
} from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { withMemoryDatabase } from '../memory/database.js';
import { normalizeBaseUrl } from '../providers/utils.js';
import { isoDate, readChats } from './data-controls-chats.js';
import { listSystemFiles, readSystemFile } from './system-files.js';

/** The phone reads at most 102 MB; leave room for the archive's own bytes. */
export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const ACCOUNT_TIMEOUT_MS = 10_000;

const README = `Your Hy data

account.json   Your HybridAI profile and whether HybridAI may use your data
               to improve Hy (only when this server is signed in to HybridAI).
chats/         Every stored chat, as JSON and as readable Markdown.
memories.json  What Hy remembers: notes, chat summaries and shared memory.
files/         The documents in each assistant's workspace.

Billing records and data in connected apps aren't included.
`;

interface ExportMessage {
  id: number;
  session: string;
  role: string;
  content: string;
  createdAt: string;
  artifacts: string | null;
  media: string | null;
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'chat';
}

function chatFiles(): Array<{ name: string; data: Buffer }> {
  const titles = new Map(readChats().map((chat) => [chat.id, chat]));
  const rows = withMemoryDatabase(
    (db) =>
      db
        .prepare(
          `SELECT m.id, COALESCE(s.session_key, m.session_id) AS chat,
                  m.session_id AS session, m.role, m.content,
                  m.created_at AS createdAt, m.artifacts_json AS artifacts,
                  m.media_json AS media, COALESCE(s.agent_id, m.agent_id) AS agent,
                  s.channel_id AS channel, s.title
           FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
           ORDER BY m.id`,
        )
        .all() as Array<
        ExportMessage & {
          chat: string;
          agent: string | null;
          channel: string | null;
          title: string | null;
        }
      >,
  );
  const chats = new Map<string, typeof rows>();
  for (const row of rows)
    chats.set(row.chat, [...(chats.get(row.chat) ?? []), row]);
  const used = new Set<string>();
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const [id, messages] of chats) {
    const known = titles.get(id);
    const title =
      known?.title ?? messages.find((message) => message.title)?.title ?? id;
    let name = safeName(id);
    for (let index = 2; used.has(name); index += 1)
      name = `${safeName(id)}-${index}`;
    used.add(name);
    const chat = {
      id,
      title,
      agent: messages[0].agent,
      channel: messages[0].channel,
      archived: known?.archived ?? false,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: isoDate(message.createdAt),
        files: parseJson(message.artifacts),
        attachments: parseJson(message.media),
      })),
    };
    files.push({
      name: `chats/${name}.json`,
      data: Buffer.from(JSON.stringify(chat, null, 2)),
    });
    const transcript = [
      `# ${title}`,
      '',
      ...chat.messages.flatMap((message) => [
        `## ${message.role} · ${message.createdAt}`,
        '',
        message.content,
        '',
      ]),
    ].join('\n');
    files.push({ name: `chats/${name}.md`, data: Buffer.from(transcript) });
  }
  return files;
}

function workspaceFiles(
  agents: string[],
  budget: { left: number },
): Array<{ name: string; data: Buffer }> {
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const agent of agents) {
    const root = agentWorkspaceDir(agent);
    const folders = [''];
    while (folders.length > 0) {
      const folder = folders.shift() as string;
      let offset: number | null = 0;
      while (offset !== null) {
        let page: ReturnType<typeof listSystemFiles>;
        try {
          page = listSystemFiles(root, folder, offset);
        } catch {
          break;
        }
        for (const entry of page.entries) {
          if (entry.kind === 'directory') folders.push(entry.path);
          if (entry.kind !== 'file') continue;
          if ((entry.size ?? 0) > budget.left) {
            throw new GatewayRequestError(413, 'This export is too large.');
          }
          let data: Buffer;
          try {
            data = readSystemFile(root, entry.path, Math.max(budget.left, 1));
          } catch (error) {
            if (
              error instanceof GatewayRequestError &&
              error.statusCode === 413
            ) {
              throw new GatewayRequestError(413, 'This export is too large.');
            }
            continue;
          }
          budget.left -= data.length;
          files.push({ name: `files/${safeName(agent)}/${entry.path}`, data });
        }
        offset = page.nextOffset;
      }
    }
  }
  return files;
}

async function accountFile(): Promise<{ name: string; data: Buffer } | null> {
  let apiKey: string;
  try {
    if (!getHybridAIAuthStatus().authenticated) return null;
    apiKey = getHybridAIApiKey();
  } catch {
    return null;
  }
  const base = normalizeBaseUrl(HYBRIDAI_BASE_URL);
  const read = async (
    path: string,
  ): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const [config, controls] = await Promise.all([
    read('/v1/app-config'),
    read('/v1/account/data-controls'),
  ]);
  const account = {
    profile: config?.user ?? null,
    productImprovement:
      typeof controls?.product_improvement === 'boolean'
        ? controls.product_improvement
        : null,
  };
  if (!account.profile && account.productImprovement === null) return null;
  return {
    name: 'account.json',
    data: Buffer.from(JSON.stringify(account, null, 2)),
  };
}

export async function buildDataExport(params: {
  agents: string[];
  memories: unknown;
}): Promise<Buffer> {
  const budget = { left: MAX_EXPORT_BYTES };
  const take = (files: Array<{ name: string; data: Buffer }>) => {
    for (const file of files) budget.left -= file.data.length;
    if (budget.left < 0) {
      throw new GatewayRequestError(413, 'This export is too large.');
    }
    return files;
  };
  const account = await accountFile();
  const entries = [
    ...take([{ name: 'README.txt', data: Buffer.from(README) }]),
    ...take(account ? [account] : []),
    ...take([
      {
        name: 'memories.json',
        data: Buffer.from(JSON.stringify(params.memories, null, 2)),
      },
    ]),
    ...take(chatFiles()),
  ];
  entries.push(...workspaceFiles(params.agents, budget));
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(entry.data, entry.name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
