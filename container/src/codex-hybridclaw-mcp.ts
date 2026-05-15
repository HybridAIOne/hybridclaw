#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CodexMcpContext } from './codex-app-types.js';
import { readRecord, readString } from './codex-app-utils.js';
import {
  executeToolWithMetadata,
  setGatewayContext,
  setMediaContext,
  setModelContext,
  setProviderCredentials,
  setTaskModelPolicies,
  setWebSearchConfig,
  TOOL_DEFINITIONS,
} from './tools.js';
import type { ToolDefinition } from './types.js';

const CALLBACK_TOOL_NAMES = new Set([
  'web_fetch',
  'web_extract',
  'web_search',
  'vision_analyze',
  'image_generate',
  'audio_transcribe',
]);

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

type SkillEntry = NonNullable<ReturnType<typeof readSkillEntry>>;

let skillEntriesCache: SkillEntry[] | null = null;

const CUSTOM_CALLBACK_TOOLS: McpToolDefinition[] = [
  {
    name: 'skill_lookup',
    description:
      'List or inspect HybridClaw skills available in the current workspace. This is read-only and returns skill names, descriptions, locations, and optionally SKILL.md body excerpts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive search across skill name and description.',
        },
        includeBody: {
          type: 'boolean',
          description: 'Include a truncated SKILL.md excerpt for matches.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of skills to return. Defaults to 20.',
        },
      },
    },
  },
  {
    name: 'voice_status',
    description:
      'Inspect read-only HybridClaw voice and TTS gateway configuration status. This does not place calls or synthesize speech.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

function isCallbackTool(tool: ToolDefinition): boolean {
  const name = tool.function.name;
  return CALLBACK_TOOL_NAMES.has(name) || name.startsWith('browser_');
}

export function isHybridClawCallbackToolName(toolName: string): boolean {
  return (
    CALLBACK_TOOL_NAMES.has(toolName) ||
    toolName.startsWith('browser_') ||
    CUSTOM_CALLBACK_TOOLS.some((tool) => tool.name === toolName)
  );
}

function readContext(): CodexMcpContext | null {
  const contextPath = String(
    process.env.HYBRIDCLAW_CODEX_MCP_CONTEXT_PATH || '',
  ).trim();
  const secretContext = readSecretContext();
  if (!contextPath) return secretContext;
  try {
    const fileContext = JSON.parse(
      fs.readFileSync(contextPath, 'utf-8'),
    ) as CodexMcpContext;
    return { ...fileContext, ...secretContext };
  } catch (error) {
    console.error(
      `[hybridclaw-mcp] failed to read context: ${error instanceof Error ? error.message : String(error)}`,
    );
    return secretContext;
  }
}

function readSecretContext(): CodexMcpContext | null {
  const encoded = String(
    process.env.HYBRIDCLAW_CODEX_MCP_SECRET_CONTEXT_B64 || '',
  ).trim();
  if (!encoded) return null;
  try {
    return JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf-8'),
    ) as CodexMcpContext;
  } catch (error) {
    console.error(
      `[hybridclaw-mcp] failed to read secret context: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function applyContext(context: CodexMcpContext | null): void {
  if (!context) return;
  setGatewayContext(
    context.gatewayBaseUrl,
    context.gatewayApiToken,
    context.channelId || 'codex-app-server',
    context.configuredDiscordChannels,
  );
  setModelContext(
    context.provider,
    context.providerMethod,
    context.baseUrl || '',
    context.apiKey || '',
    context.model || '',
    context.chatbotId || '',
    context.requestHeaders,
    context.maxTokens,
    context.debugModelResponses === true,
  );
  setTaskModelPolicies(context.taskModels);
  setMediaContext(context.media);
  setWebSearchConfig(context.webSearch);
  setProviderCredentials(context.providerCredentials);
}

function buildMcpTool(tool: ToolDefinition): McpToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
  };
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.floor(value)))
    : 20;
}

function firstFrontmatterValue(body: string, key: string): string {
  const pattern = new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'im');
  return body.match(pattern)?.[1]?.trim() || '';
}

function readSkillEntry(skillFile: string): {
  name: string;
  description: string;
  location: string;
  body: string;
} | null {
  try {
    const body = fs.readFileSync(skillFile, 'utf-8');
    const name =
      firstFrontmatterValue(body, 'name') ||
      path.basename(path.dirname(skillFile));
    const description = firstFrontmatterValue(body, 'description');
    return {
      name,
      description,
      location: skillFile,
      body,
    };
  } catch {
    return null;
  }
}

function candidateSkillRoots(): string[] {
  return [
    path.join(process.cwd(), 'skills'),
    path.join(process.cwd(), '.synced-skills'),
    '/workspace/skills',
    '/workspace/.synced-skills',
  ];
}

function loadSkillEntries(): SkillEntry[] {
  if (skillEntriesCache) return skillEntriesCache;
  const entries = new Map<
    string,
    NonNullable<ReturnType<typeof readSkillEntry>>
  >();
  for (const root of candidateSkillRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const entry = readSkillEntry(path.join(root, dirent.name, 'SKILL.md'));
      if (entry) entries.set(entry.location, entry);
    }
  }
  skillEntriesCache = [...entries.values()];
  return skillEntriesCache;
}

function handleSkillLookup(args: Record<string, unknown>): string {
  const query = readString(args.query).trim().toLowerCase();
  const includeBody = readBoolean(args.includeBody);
  const limit = readLimit(args.limit);
  const skills = loadSkillEntries()
    .filter((skill) => {
      if (!query) return true;
      return (
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query)
      );
    })
    .slice(0, limit)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: skill.location,
      ...(includeBody ? { body: skill.body.slice(0, 12_000) } : {}),
    }));
  return JSON.stringify({ skills }, null, 2);
}

function gatewayStatusUrl(context: CodexMcpContext | null): string | null {
  const baseUrl = String(context?.gatewayBaseUrl || '').trim();
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/status`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function handleVoiceStatus(
  context: CodexMcpContext | null,
): Promise<string> {
  const url = gatewayStatusUrl(context);
  if (!url) {
    return JSON.stringify(
      {
        ok: false,
        error:
          'HybridClaw voice status is unavailable because gatewayBaseUrl is not configured.',
      },
      null,
      2,
    );
  }

  const headers: Record<string, string> = {};
  if (context?.gatewayApiToken) {
    headers.Authorization = `Bearer ${context.gatewayApiToken}`;
  }
  const response = await fetch(url, { method: 'GET', headers });
  const rawText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const maybe = JSON.parse(rawText) as unknown;
    if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
      parsed = maybe as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    return JSON.stringify(
      {
        ok: false,
        status: response.status,
        error: parsed?.error || rawText || `HTTP ${response.status}`,
      },
      null,
      2,
    );
  }

  return JSON.stringify({ ok: true, voice: parsed?.voice ?? null }, null, 2);
}

export function buildUnavailableCallbackToolResult(toolName: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: `HybridClaw callback tool is unavailable in Codex app-server mode: ${toolName}`,
      },
    ],
    isError: true,
  };
}

export function getHybridClawCallbackMcpToolNames(): string[] {
  return [
    ...TOOL_DEFINITIONS.filter(isCallbackTool).map(
      (tool) => tool.function.name,
    ),
    ...CUSTOM_CALLBACK_TOOLS.map((tool) => tool.name),
  ];
}

async function main(): Promise<void> {
  const context = readContext();
  applyContext(context);
  const tools = [
    ...TOOL_DEFINITIONS.filter(isCallbackTool).map(buildMcpTool),
    ...CUSTOM_CALLBACK_TOOLS,
  ];
  const server = new Server(
    { name: 'hybridclaw-callback', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'HybridClaw callback tools exposed to Codex app-server. Use these for web extraction, browser automation, image/vision, and audio surfaces when available.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    if (toolName === 'skill_lookup') {
      return {
        content: [
          {
            type: 'text',
            text: handleSkillLookup(readRecord(request.params.arguments)),
          },
        ],
        isError: false,
      };
    }
    if (toolName === 'voice_status') {
      return {
        content: [{ type: 'text', text: await handleVoiceStatus(context) }],
        isError: false,
      };
    }
    const known = TOOL_DEFINITIONS.some(
      (tool) => tool.function.name === toolName,
    );
    if (!known || !tools.some((tool) => tool.name === toolName)) {
      return buildUnavailableCallbackToolResult(toolName);
    }

    const result = await executeToolWithMetadata(
      toolName,
      JSON.stringify(request.params.arguments || {}),
    );
    return {
      content: [{ type: 'text', text: result.output }],
      isError: result.isError,
    };
  });

  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `[hybridclaw-mcp] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
