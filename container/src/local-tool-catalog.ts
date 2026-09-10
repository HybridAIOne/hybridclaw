/**
 * Local requests expose stable starter schemas and bounded discovery results.
 * Only tools admitted by the request policy enter this catalog. Calls unwrap
 * before approval/audit; unlike tools.ts this module never executes actions.
 * Deferred arguments are schema-checked; invalid shapes return bounded feedback.
 * Unavailable actions remain rejected; guidance names the exposed schemas.
 */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  DEFAULT_LOCAL_STARTER_TOOLS,
  normalizeLocalStarterTools,
} from '../shared/local-tool-config.js';
import { searchCatalog } from './catalog-search.js';
import type { ToolCall, ToolDefinition, ToolRunResult } from './types.js';

const NAME = 'tool_catalog';
// Engineering choice, 2026-09-10: bounded discovery leaves context for task work.
// Tokenizer-aware schema budgets are deferred; native context admission still applies.
const PAGE_SIZE = 10;
const MAX_SCHEMA_CHARS = 24_000;
// Engineering choice, 2026-09-10: two catalog corrections per request.
// Missing fields/lookups may recover; unavailable actions stay fail-fast.
const MAX_CATALOG_CORRECTIONS = 2;
const CATALOG_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: NAME,
    description:
      'Discover tools in steps: action=list searches short summaries with query and offset; follow a result’s next call to describe its input schema; then action=call executes that exact name with matching arguments. Use keywords for the task, not a guessed tool name. If an exact name and its parameters are already known, skip discovery. Skills are instruction packages: discover them with skills_list, not a tool named after the skill. Calls keep normal permissions and approvals.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'describe', 'call'] },
        query: {
          type: 'string',
          description:
            'Keywords ranked across tool names, descriptions, and parameter names.',
        },
        offset: {
          type: 'integer',
          description:
            'Page offset for list (default 0, ten results per page).',
        },
        name: {
          type: 'string',
          description:
            'Required on every call. Exact tool name for describe or call; use an empty string for list.',
        },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description:
            'Arguments matching the described tool schema; required for call.',
        },
      },
      required: ['action', 'name'],
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

class CatalogArgumentError extends Error {}

export class LocalToolCatalog {
  readonly tools: ToolDefinition[];
  private readonly byName: Map<string, ToolDefinition>;
  private readonly starters: Set<string>;
  private corrections = 0;
  private readonly validators = new Map<
    string,
    ReturnType<AjvJsonSchemaValidator['getValidator']>
  >();

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
      directory && this.byName.has('bash') && !names.includes('bash')
        ? 'To run a command from skill instructions, first call tool_catalog with {"action":"describe","name":"bash"}, then call tool_catalog with {"action":"call","name":"bash","arguments":{"command":"the command"}}. Never emit a direct bash call: it is not an exposed function.'
        : '',
      directory && this.byName.has('skills_list')
        ? 'Skill discovery is staged: search skills_list summaries, request details with the exact skill name, then execute the returned next call to read its instructions. Search results are not skill instructions. Follow next.name and next.arguments exactly; discovery does not expose additional functions.'
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
    if (typeof args.name !== 'string')
      throw new CatalogArgumentError(
        'Tool catalog requires a top-level name on every call. Use the exact tool name for describe/call, or an empty string for list.',
      );
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
      if (typeof args.name !== 'string' || !args.name.trim())
        throw new Error('Tool catalog describe requires an exact tool name.');
      if (this.corrections >= MAX_CATALOG_CORRECTIONS)
        this.requireTool(args.name);
      return call;
    }
    if (args.action !== 'call')
      throw new Error('Tool catalog action must be list, describe, or call.');
    if (typeof args.name !== 'string' || !args.name.trim())
      throw new CatalogArgumentError(
        'Tool catalog call requires a top-level name containing the exact tool name. Put the file path inside arguments.path, not name.',
      );
    const tool = this.requireTool(args.name);
    if (
      !args.arguments ||
      typeof args.arguments !== 'object' ||
      Array.isArray(args.arguments)
    )
      throw new CatalogArgumentError(
        'Tool catalog call requires an arguments object.',
      );
    let validate = this.validators.get(tool.function.name);
    if (!validate) {
      try {
        // Isolate schema ids across tools; no remote resolver or coercion is installed.
        validate = new AjvJsonSchemaValidator().getValidator(
          tool.function.parameters,
        );
      } catch {
        throw new Error(
          'This tool schema cannot be validated for local discovery. No action was executed.',
        );
      }
      this.validators.set(tool.function.name, validate);
    }
    if (!validate(args.arguments).valid) {
      throw new CatalogArgumentError(
        `Arguments do not match the selected tool schema. Use tool_catalog action=describe with name=${JSON.stringify(tool.function.name)} to inspect required fields and types, then retry.`,
      );
    }
    return {
      ...call,
      function: {
        name: tool.function.name,
        arguments: JSON.stringify(args.arguments),
      },
    };
  }

  recoverArgumentError(error: unknown): ToolRunResult | null {
    if (
      !(error instanceof CatalogArgumentError) ||
      this.corrections >= MAX_CATALOG_CORRECTIONS
    )
      return null;
    this.corrections += 1;
    return {
      output: `Error: ${error.message} No tool in this batch was executed. Retry tool_catalog with all three fields: action="call", name (the exact described tool name), and arguments (an object matching its parameters).`,
      isError: true,
    };
  }

  discoveryResult(call: ToolCall): ToolRunResult | null {
    if (call.function.name !== NAME) return null;
    this.resolveCall(call);
    const args = readArgs(call.function.arguments);
    if (args.action === 'describe') {
      const tool = this.byName.get(args.name as string);
      if (!tool) {
        this.corrections += 1;
        return {
          output: [
            'Error: Tool is not available in this request. No action was executed.',
            'Skill names and file paths are not tool names. Use tool_catalog action=list with a keyword query to find a permitted tool, then describe its exact name.',
            this.byName.has('read')
              ? 'To read a skill file, describe the tool named read, then call it through tool_catalog with the skill location as path.'
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          isError: true,
        };
      }
      // Describe the callable wrapper, not a new top-level function. The model
      // sees the target's exact parameters without changing its supplied tools.
      const output = JSON.stringify({
        type: 'function',
        function: {
          name: NAME,
          description: `Execute ${tool.function.name} using action="call", name="${tool.function.name}", and arguments matching the schema below. ${tool.function.description}`,
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['call'] },
              name: { type: 'string', enum: [tool.function.name] },
              arguments: tool.function.parameters,
            },
            required: ['action', 'name', 'arguments'],
          },
        },
      });
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
    const matches = searchCatalog(
      [...this.byName.values()].filter(
        (tool) => !this.starters.has(tool.function.name),
      ),
      query,
      (tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        keywords: Object.keys(tool.function.parameters.properties ?? {}).join(
          ' ',
        ),
      }),
    );
    const page = matches.slice(offset, offset + PAGE_SIZE);
    return {
      output: JSON.stringify({
        tools: page.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description.slice(0, 160),
          required: (tool.function.parameters.required ?? []).slice(0, 16),
          next: {
            name: NAME,
            arguments: { action: 'describe', name: tool.function.name },
          },
        })),
        total: matches.length,
        availableCount:
          this.byName.size -
          [...this.byName.keys()].filter((name) => this.starters.has(name))
            .length,
        hint: matches.length
          ? 'Choose a matching tool and execute its next call to load the schema. Then use tool_catalog action=call; only supplied function names are directly callable.'
          : 'No keyword matches. Try fewer keywords or omit query to browse the permitted tools. Skill names are not tool names; use skills_list for skill discovery.',
        nextOffset:
          offset + page.length < matches.length ? offset + page.length : null,
      }),
      isError: false,
    };
  }
}
