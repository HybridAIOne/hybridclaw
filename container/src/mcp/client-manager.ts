/**
 * MCP connections own discovered tools and bind scheduling trust to their config.
 * Overlap needs both live and requested config trust, including after a failed
 * replacement. Unlike approval-policy, this manager does not grant approvals
 * or infer concurrency from tool names.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolResult,
  Tool as SdkTool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { parseMcpToolBehaviorConfig } from '../../shared/mcp-server-config.js';
import {
  buildMcpServerNamespaces,
  sanitizeMcpToolSegment,
} from '../../shared/mcp-tool-namespaces.js';
import { emitRuntimeEvent } from '../extensions.js';
import type { ToolDefinition, ToolRunResult } from '../types.js';
import { classifyMcpTool, isResendSafe } from './tool-classifier.js';
import { isParallelSafeMcpTool } from './tool-concurrency.js';
import {
  DEFER_LOADING_META,
  type LiveHeaders,
  type McpClientHandle,
  type McpServerConfig,
  type McpToolBehavior,
  type McpToolDefinition,
} from './types.js';

const MCP_CONNECT_TIMEOUT_MS = 60_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
// 32,000 chars of serialized schema per server, ≈8K tokens (agent call,
// 2026-10-02, pending owner review). A server past it goes behind
// tool_catalog: Zoho-sized (32 tools, 56K) is deferred, HybridAI's connectors
// (42 tools, 25K) stay loaded because a catalog step costs a model round trip.
// Deferred: a budget for the whole tool payload, and compacting nested
// property descriptions instead of deferring whole servers.
const MAX_LOADED_SERVER_SCHEMA_CHARS = 32_000;
const MCP_CLIENT_INFO = {
  name: 'hybridclaw-agent',
  version: process.env.npm_package_version || '0.0.0',
};

interface ToolIndexEntry extends McpToolBehavior {
  serverName: string;
  toolName: string;
}

interface ListToolsResult {
  tools: SdkTool[];
  nextCursor?: string;
}

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function cloneConfig(config: McpServerConfig): McpServerConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as McpServerConfig;
  cloned.toolBehavior = parseMcpToolBehaviorConfig(cloned.toolBehavior);
  return cloned;
}

/**
 * Adds `headers` to every request on top of the SDK's own. They are read per
 * request, so a rotated token takes effect without a new connection.
 */
function fetchWithHeaders(headers: LiveHeaders): FetchLike {
  return (url, init) => {
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers.current)) {
      merged.set(key, value);
    }
    return fetch(url, { ...init, headers: merged });
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A JSON-RPC error the server sent back (bad arguments, a failure inside the
 * tool, output that fails its schema): the connection works, so the server
 * keeps its tools and the same call is not sent again.
 */
function isAnsweredByServer(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code !== ErrorCode.ConnectionClosed &&
    error.code !== ErrorCode.RequestTimeout
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function buildNamespacedToolName(
  serverNamespace: string,
  toolName: string,
  seen: Set<string>,
): string {
  const base = `${serverNamespace}__${sanitizeMcpToolSegment(toolName)}`;
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  const deduped = `${base}_${stableHash(`${serverNamespace}:${toolName}`)}`;
  seen.add(deduped);
  return deduped;
}

function normalizeParametersSchema(
  inputSchema: Record<string, unknown>,
): ToolDefinition['function']['parameters'] {
  const properties = isRecord(inputSchema.properties)
    ? inputSchema.properties
    : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];
  return {
    ...inputSchema,
    type: 'object',
    properties:
      properties as ToolDefinition['function']['parameters']['properties'],
    required,
  } as ToolDefinition['function']['parameters'];
}

function renderToolBlock(block: CallToolResult['content'][number]): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource':
      return 'text' in block.resource
        ? block.resource.text
        : `[resource ${block.resource.uri}]`;
    case 'resource_link':
      return `[resource link ${block.name}: ${block.uri}]`;
    case 'image':
      return `[image ${block.mimeType}]`;
    case 'audio':
      return `[audio ${block.mimeType}]`;
    default:
      return JSON.stringify(block);
  }
}

function renderCallToolResult(result: CallToolResult): string {
  const segments: string[] = [];
  for (const block of result.content || []) {
    const rendered = renderToolBlock(block).trim();
    if (rendered) segments.push(rendered);
  }
  if (
    result.structuredContent &&
    Object.keys(result.structuredContent).length
  ) {
    segments.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const body =
    segments.join('\n\n').trim() ||
    (result.isError
      ? 'MCP tool returned an error without textual details.'
      : 'MCP tool completed with no textual output.');
  return result.isError ? `Error: ${body}` : body;
}

export class McpClientManager {
  private readonly clients = new Map<string, McpClientHandle>();
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly toolIndex = new Map<string, ToolIndexEntry>();
  private readonly closingServers = new Set<string>();
  private readonly replaceLocks = new Map<string, Promise<void>>();

  async initFromConfig(
    servers: Record<string, McpServerConfig>,
  ): Promise<void> {
    for (const [name, config] of Object.entries(servers)) {
      await this.replaceClient(name, config);
    }
  }

  isKnownTool(name: string): boolean {
    return this.toolIndex.has(name);
  }

  getToolBehavior(name: string): McpToolBehavior | undefined {
    const entry = this.toolIndex.get(name);
    const handle = entry && this.clients.get(entry.serverName);
    const config = entry && this.configs.get(entry.serverName);
    return (
      entry && {
        kind: entry.kind,
        annotations: entry.annotations,
        parallelSafe:
          !!handle &&
          !!config &&
          isParallelSafeMcpTool(config, entry.toolName, entry.annotations) &&
          isParallelSafeMcpTool(
            handle.config,
            entry.toolName,
            entry.annotations,
          ),
      }
    );
  }

  hasServer(name: string): boolean {
    return this.configs.has(name);
  }

  async removeClient(name: string): Promise<void> {
    this.configs.delete(name);
    await this.disconnectClient(name);
  }

  async replaceClient(name: string, config: McpServerConfig): Promise<void> {
    return this.runWithLock(name, () => this.connectClient(name, config));
  }

  /**
   * Applies a config that differs only in its `Authorization` header (the
   * gateway's OAuth refresh). A healthy HTTP/SSE connection sends the new
   * header from its next request on and keeps its session and tools; a server
   * without one connects with the new header.
   */
  async rotateAuthorization(
    name: string,
    config: McpServerConfig,
  ): Promise<void> {
    return this.runWithLock(name, async () => {
      const handle = this.clients.get(name);
      if (!handle?.headers || !handle.healthy) {
        await this.connectClient(name, config);
        return;
      }
      this.configs.set(name, cloneConfig(config));
      handle.config = cloneConfig(config);
      handle.headers.current = { ...config.headers };
    });
  }

  async reconnectClient(name: string): Promise<void> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);
    await this.replaceClient(name, config);
  }

  async rebuildClient(name: string): Promise<void> {
    await this.reconnectClient(name);
  }

  getAllToolDefinitions(): ToolDefinition[] {
    return Array.from(this.clients.values()).flatMap((handle) =>
      handle.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: normalizeParametersSchema(tool.inputSchema),
        },
      })),
    );
  }

  /**
   * Tools of `requestTools` to load only when needed: those their server
   * marks, and every tool of a server whose unmarked schemas in this request
   * together exceed MAX_LOADED_SERVER_SCHEMA_CHARS. Sized from the definitions
   * the model receives, so a request defers the same set on every worker.
   */
  getDeferLoadingToolNames(requestTools: ToolDefinition[]): string[] {
    const offered = new Map(
      requestTools.map((tool) => [tool.function.name, tool]),
    );
    return Array.from(this.clients.values()).flatMap((handle) => {
      const tools = handle.tools.filter((tool) => offered.has(tool.name));
      const loadedChars = tools
        .filter((tool) => !tool.deferLoading)
        .reduce(
          (sum, tool) => sum + JSON.stringify(offered.get(tool.name)).length,
          0,
        );
      const oversized = loadedChars > MAX_LOADED_SERVER_SCHEMA_CHARS;
      return tools
        .filter((tool) => oversized || tool.deferLoading)
        .map((tool) => tool.name);
    });
  }

  async callToolDetailed(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<ToolRunResult> {
    const entry = this.toolIndex.get(namespacedName);
    if (!entry) throw new Error(`Unknown MCP tool: ${namespacedName}`);
    return this.callToolOnServer(
      entry.serverName,
      entry.toolName,
      namespacedName,
      args,
      isResendSafe(entry.annotations) ? 'resend' : 'reconnect',
    );
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.callToolDetailed(namespacedName, args);
    return result.output;
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.clients.keys()]) {
      await this.disconnectClient(name);
    }
    this.configs.clear();
  }

  private async connectClient(
    name: string,
    config: McpServerConfig,
  ): Promise<void> {
    this.configs.set(name, cloneConfig(config));
    if (config.enabled === false) {
      await this.disconnectClient(name);
      return;
    }

    const existing = this.clients.get(name);
    const nextHandle = await this.buildClient(name, config);
    this.clients.set(name, nextHandle);
    this.rebuildToolIndex();
    await emitRuntimeEvent({
      event: 'mcp_server_connected',
      serverName: name,
      transport: config.transport,
      toolCount: nextHandle.tools.length,
    });
    if (existing) await this.closeHandle(existing);
  }

  private async buildClient(
    name: string,
    config: McpServerConfig,
  ): Promise<McpClientHandle> {
    const headers: LiveHeaders | undefined =
      config.transport === 'stdio'
        ? undefined
        : { current: { ...config.headers } };
    const transport = this.createTransport(name, config, headers);
    this.attachTransportHandlers(name, transport);

    if (transport instanceof StdioClientTransport && transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer | string) => {
        const line = String(chunk || '').trim();
        if (line) console.error(`[mcp:${name}] ${line}`);
      });
    }

    const client = new Client(MCP_CLIENT_INFO, { capabilities: {} });
    await withTimeout(
      client.connect(transport),
      MCP_CONNECT_TIMEOUT_MS,
      `Connect to MCP server ${name}`,
    );

    const handle: McpClientHandle = {
      serverName: name,
      config: cloneConfig(config),
      client,
      transport,
      headers,
      tools: [],
      healthy: true,
    };

    try {
      handle.tools = await this.discoverTools(handle);
    } catch (error) {
      await this.closeHandle(handle);
      throw error;
    }

    return handle;
  }

  private createTransport(
    name: string,
    config: McpServerConfig,
    headers: LiveHeaders = { current: {} },
  ) {
    switch (config.transport) {
      case 'stdio': {
        const command = normalizeText(config.command);
        if (!command) {
          throw new Error(`MCP server ${name} requires a command for stdio`);
        }
        return new StdioClientTransport({
          command,
          args: Array.isArray(config.args) ? [...config.args] : [],
          env: {
            ...getDefaultEnvironment(),
            ...(config.env || {}),
          },
          ...(config.cwd ? { cwd: config.cwd } : {}),
          stderr: 'pipe',
        });
      }
      case 'http': {
        const url = normalizeText(config.url);
        if (!url) {
          throw new Error(`MCP server ${name} requires a URL for http`);
        }
        return new StreamableHTTPClientTransport(new URL(url), {
          fetch: fetchWithHeaders(headers),
        });
      }
      case 'sse': {
        const url = normalizeText(config.url);
        if (!url) {
          throw new Error(`MCP server ${name} requires a URL for sse`);
        }
        return new SSEClientTransport(new URL(url), {
          fetch: fetchWithHeaders(headers),
        });
      }
      default:
        throw new Error(`Unsupported MCP transport for ${name}`);
    }
  }

  private attachTransportHandlers(
    name: string,
    transport:
      | StdioClientTransport
      | SSEClientTransport
      | StreamableHTTPClientTransport,
  ): void {
    transport.onerror = (error: unknown) => {
      if (this.closingServers.has(name)) return;
      // Transports also report errors they recover from, such as an SSE stream
      // that reconnects. A dead connection surfaces as onclose or a failed call.
      void emitRuntimeEvent({
        event: 'mcp_server_error',
        serverName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    transport.onclose = () => {
      if (this.closingServers.has(name)) return;
      this.markServerUnhealthy(name, new Error('MCP transport closed'));
      void emitRuntimeEvent({
        event: 'mcp_server_disconnected',
        serverName: name,
      });
    };
  }

  private async discoverTools(
    handle: McpClientHandle,
  ): Promise<McpToolDefinition[]> {
    const serverNamespace = this.getServerNamespace(handle.serverName);
    const seenNames = new Set<string>();
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    do {
      const result = (await withTimeout(
        handle.client.listTools(cursor ? { cursor } : undefined),
        MCP_CONNECT_TIMEOUT_MS,
        `List tools from MCP server ${handle.serverName}`,
      )) as ListToolsResult;
      tools.push(
        ...this.mapTools(
          handle.serverName,
          serverNamespace,
          result.tools,
          seenNames,
        ),
      );
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  }

  private mapTools(
    serverName: string,
    serverNamespace: string,
    tools: SdkTool[],
    seenNames: Set<string>,
  ): McpToolDefinition[] {
    return tools.map((tool) => {
      const namespacedName = buildNamespacedToolName(
        serverNamespace,
        tool.name,
        seenNames,
      );
      const rawSchema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
      const description = normalizeText(tool.description)
        ? `[MCP ${serverName}] ${normalizeText(tool.description)}`
        : `[MCP ${serverName}] Tool ${tool.name}`;
      return {
        serverName,
        originalName: tool.name,
        name: namespacedName,
        description,
        inputSchema: rawSchema,
        kind: classifyMcpTool(tool.name, tool.annotations),
        annotations: tool.annotations,
        ...(tool._meta?.[DEFER_LOADING_META] === true
          ? { deferLoading: true }
          : {}),
      };
    });
  }

  private async callToolOnServer(
    serverName: string,
    toolName: string,
    namespacedName: string,
    args: Record<string, unknown>,
    retry: 'resend' | 'reconnect' | 'none',
  ): Promise<ToolRunResult> {
    const handle = this.clients.get(serverName);
    if (!handle) {
      throw new Error(`MCP server ${serverName} is not connected`);
    }

    try {
      // Without an explicit timeout the SDK applies its own 60 s default.
      const result = (await handle.client.callTool(
        {
          name: toolName,
          arguments: args,
        },
        CallToolResultSchema,
        { timeout: MCP_TOOL_CALL_TIMEOUT_MS },
      )) as CallToolResult;
      handle.healthy = true;
      handle.lastError = undefined;
      const rendered = renderCallToolResult(result);
      await emitRuntimeEvent({
        event: 'mcp_tool_call',
        serverName,
        toolName: namespacedName,
        ok: !result.isError,
      });
      return {
        output: rendered,
        isError: result.isError === true,
      };
    } catch (error) {
      if (isAnsweredByServer(error)) throw error;
      this.markServerUnhealthy(serverName, error);
      await emitRuntimeEvent({
        event: 'mcp_server_error',
        serverName,
        error: error instanceof Error ? error.message : String(error),
      });
      if (retry === 'none') throw error;
      // Reconnect either way: a failed server has no tools until it does.
      await this.rebuildClient(serverName);
      if (retry === 'reconnect') throw error;
      return this.callToolOnServer(
        serverName,
        toolName,
        namespacedName,
        args,
        'none',
      );
    }
  }

  private async disconnectClient(name: string): Promise<void> {
    const handle = this.clients.get(name);
    if (!handle) return;
    this.clients.delete(name);
    this.rebuildToolIndex();
    await this.closeHandle(handle);
    await emitRuntimeEvent({
      event: 'mcp_server_disconnected',
      serverName: name,
    });
  }

  private markServerUnhealthy(name: string, error: unknown): void {
    const handle = this.clients.get(name);
    if (!handle) return;
    handle.healthy = false;
    handle.lastError = error instanceof Error ? error.message : String(error);
    handle.tools = [];
    this.rebuildToolIndex();
  }

  private rebuildToolIndex(): void {
    this.toolIndex.clear();
    this.refreshToolNames();
    for (const handle of this.clients.values()) {
      if (!handle.healthy) continue;
      for (const tool of handle.tools) {
        this.toolIndex.set(tool.name, {
          serverName: handle.serverName,
          toolName: tool.originalName,
          kind: tool.kind,
          annotations: tool.annotations,
        });
      }
    }
  }

  private getServerNamespace(serverName: string): string {
    return (
      buildMcpServerNamespaces(this.configs.keys()).get(serverName) ||
      sanitizeMcpToolSegment(serverName)
    );
  }

  private refreshToolNames(): void {
    const serverNamespaces = buildMcpServerNamespaces(this.configs.keys());

    for (const handle of this.clients.values()) {
      const serverNamespace =
        serverNamespaces.get(handle.serverName) ||
        sanitizeMcpToolSegment(handle.serverName);
      const seenNames = new Set<string>();

      for (const tool of handle.tools) {
        tool.name = buildNamespacedToolName(
          serverNamespace,
          tool.originalName,
          seenNames,
        );
      }
    }
  }

  private async closeHandle(handle: McpClientHandle): Promise<void> {
    this.closingServers.add(handle.serverName);
    try {
      await handle.client.close();
    } finally {
      this.closingServers.delete(handle.serverName);
    }
  }

  private async runWithLock(
    name: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.replaceLocks.get(name);
    if (previous) await previous;

    const current = operation().finally(() => {
      if (this.replaceLocks.get(name) === current) {
        this.replaceLocks.delete(name);
      }
    });
    this.replaceLocks.set(name, current);
    return current;
  }
}
