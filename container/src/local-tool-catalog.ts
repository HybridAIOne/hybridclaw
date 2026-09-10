/**
 * Local requests expose stable starter schemas and bounded discovery results.
 * Only tools admitted by the request policy enter this catalog. Calls unwrap
 * before approval/audit; unlike tools.ts this module never executes actions.
 * Prompt guidance names only the schemas actually exposed for this request.
 */
import {
  DEFAULT_LOCAL_STARTER_TOOLS,
  normalizeLocalStarterTools,
} from '../shared/local-tool-config.js';
import type { ToolCall, ToolDefinition, ToolRunResult } from './types.js';

const NAME = 'tool_catalog';
// Engineering choice, 2026-09-10: bounded discovery leaves context for task work.
// Tokenizer-aware schema budgets are deferred; native context admission still applies.
const PAGE_SIZE = 10;
const MAX_SCHEMA_CHARS = 24_000;
const CATALOG_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: NAME,
    description:
      'Discover and use additional tools without loading the full catalog. Use action=list with an optional keyword query and offset to browse tool summaries. Use action=describe with a name to get one tool schema, then action=call with that name and arguments to execute it. Calls use the normal permissions and approvals. For tools not shown in the starter set, use this tool instead of guessing arguments.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'describe', 'call'] },
        query: {
          type: 'string',
          description: 'Keyword search across tool names and descriptions.',
        },
        offset: {
          type: 'integer',
          description:
            'Page offset for list (default 0, ten results per page).',
        },
        name: {
          type: 'string',
          description: 'Exact tool name for describe or call.',
        },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description:
            'Arguments matching the described tool schema; required for call.',
        },
      },
      required: ['action'],
    },
  },
};

function readArgs(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid local tool arguments: expected a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid local tool arguments: expected a JSON object.');
  return value as Record<string, unknown>;
}

export class LocalToolCatalog {
  readonly tools: ToolDefinition[];
  private readonly byName: Map<string, ToolDefinition>;
  private readonly starters: Set<string>;

  constructor(
    availableTools: ToolDefinition[],
    starterTools?: string[],
    discoveryDisabled = false,
  ) {
    if (availableTools.some((tool) => tool.function.name === NAME))
      throw new Error('The tool_catalog name is reserved for local discovery.');
    this.byName = new Map(
      availableTools.map((tool) => [tool.function.name, tool]),
    );
    this.starters = new Set(
      normalizeLocalStarterTools(starterTools, 'localStarterTools') ??
        DEFAULT_LOCAL_STARTER_TOOLS,
    );
    this.tools = availableTools.filter((tool) =>
      this.starters.has(tool.function.name),
    );
    if (
      !discoveryDisabled &&
      availableTools.some((tool) => !this.starters.has(tool.function.name))
    )
      this.tools.push(CATALOG_TOOL);
    this.tools.sort((a, b) => a.function.name.localeCompare(b.function.name));
  }

  promptGuidance(): string {
    const names = this.tools.map((tool) => tool.function.name);
    const directory = names.includes(NAME);
    return [
      '## Local tool call boundary',
      names.length
        ? `The only directly callable functions in this request are ${names.join(names.length === 2 ? ' and ' : ', ')}.`
        : 'No functions are exposed in this request.',
      directory && !names.includes('read')
        ? 'To read a skill file, first call tool_catalog with {"action":"describe","name":"read"}, then call tool_catalog with {"action":"call","name":"read","arguments":{"path":"the skill location"}}. Never emit a direct read call: it is not an exposed function.'
        : '',
      directory
        ? 'For other tools absent from the exposed functions, use tool_catalog to list or describe them, then call them through tool_catalog. The directory can reject tools that are unavailable or blocked.'
        : 'Tool discovery is not exposed. Do not claim access to any additional tools.',
      'All tool calls must use the names in the supplied function schemas.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private requireTool(name: unknown): ToolDefinition {
    const tool = typeof name === 'string' ? this.byName.get(name) : undefined;
    if (!tool)
      throw new Error(
        'Tool is not available in this request. Use tool_catalog to discover permitted tools.',
      );
    return tool;
  }

  resolveCall(call: ToolCall): ToolCall {
    readArgs(call.function.arguments);
    if (call.function.name !== NAME) {
      this.requireTool(call.function.name);
      return call;
    }
    if (!this.tools.some((tool) => tool.function.name === NAME))
      throw new Error('Tool discovery is not available in this request.');
    const args = readArgs(call.function.arguments);
    if (args.action === 'list') {
      if (args.query !== undefined && typeof args.query !== 'string')
        throw new Error('Tool catalog query must be a string.');
      if (
        args.offset !== undefined &&
        (typeof args.offset !== 'number' ||
          !Number.isSafeInteger(args.offset) ||
          args.offset < 0)
      )
        throw new Error('Tool catalog offset must be a non-negative integer.');
      return call;
    }
    if (args.action === 'describe') {
      this.requireTool(args.name);
      return call;
    }
    if (args.action !== 'call')
      throw new Error('Tool catalog action must be list, describe, or call.');
    const tool = this.requireTool(args.name);
    if (
      !args.arguments ||
      typeof args.arguments !== 'object' ||
      Array.isArray(args.arguments)
    )
      throw new Error('Tool catalog call requires an arguments object.');
    return {
      ...call,
      function: {
        name: tool.function.name,
        arguments: JSON.stringify(args.arguments),
      },
    };
  }

  discoveryResult(call: ToolCall): ToolRunResult | null {
    if (call.function.name !== NAME) return null;
    this.resolveCall(call);
    const args = readArgs(call.function.arguments);
    if (args.action === 'describe') {
      const output = JSON.stringify(this.requireTool(args.name));
      return output.length > MAX_SCHEMA_CHARS
        ? {
            output:
              'Error: This tool schema is too large for local discovery. Use a smaller tool or a model with a larger context.',
            isError: true,
          }
        : { output, isError: false };
    }
    if (args.action !== 'list')
      throw new Error('Catalog calls must be resolved before execution.');
    const query =
      typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const matches = [...this.byName.values()]
      .filter((tool) => !this.starters.has(tool.function.name))
      .filter((tool) =>
        `${tool.function.name} ${tool.function.description}`
          .toLowerCase()
          .includes(query),
      )
      .sort((a, b) => a.function.name.localeCompare(b.function.name));
    const page = matches.slice(offset, offset + PAGE_SIZE);
    return {
      output: JSON.stringify({
        tools: page.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description.slice(0, 160),
        })),
        total: matches.length,
        nextOffset:
          offset + page.length < matches.length ? offset + page.length : null,
      }),
      isError: false,
    };
  }
}
