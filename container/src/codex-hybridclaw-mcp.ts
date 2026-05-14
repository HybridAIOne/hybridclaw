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
import type { ContainerInput, ToolDefinition } from './types.js';

interface McpContext {
  provider?: ContainerInput['provider'];
  providerMethod?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  chatbotId?: string;
  requestHeaders?: Record<string, string>;
  maxTokens?: number;
  debugModelResponses?: boolean;
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  channelId?: string;
  configuredDiscordChannels?: string[];
  taskModels?: ContainerInput['taskModels'];
  media?: ContainerInput['media'];
  webSearch?: ContainerInput['webSearch'];
  providerCredentials?: ContainerInput['providerCredentials'];
}

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
    name: 'tts_status',
    description:
      'Explain whether HybridClaw text-to-speech is available through the safe Codex app-server MCP callback surface.',
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

function readContext(): McpContext | null {
  const contextPath = String(
    process.env.HYBRIDCLAW_CODEX_MCP_CONTEXT_PATH || '',
  ).trim();
  if (!contextPath) return null;
  try {
    return JSON.parse(fs.readFileSync(contextPath, 'utf-8')) as McpContext;
  } catch (error) {
    console.error(
      `[hybridclaw-mcp] failed to read context: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function applyContext(context: McpContext | null): void {
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

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function loadSkillEntries(): Array<{
  name: string;
  description: string;
  location: string;
  body: string;
}> {
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
  return [...entries.values()];
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

function handleTtsStatus(): string {
  return [
    'HybridClaw text-to-speech is not exposed as a Codex app-server MCP callback.',
    'Voice relay TTS is managed by the gateway and may place or affect live calls, so it is intentionally unavailable from this safe callback surface.',
  ].join(' ');
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
  applyContext(readContext());
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
    if (toolName === 'tts_status') {
      return {
        content: [{ type: 'text', text: handleTtsStatus() }],
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
