/**
 * Stable request schemas and bounded discovery for admitted tools only.
 * Local requests choose starters; remote requests defer bulky schemas.
 * Small schemas travel with discovery; large ones require describe. Deferred
 * calls are validated and unwrap before approval/audit; unlike tools.ts this
 * module never executes actions or grants permissions.
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
// Engineering choice, 2026-10-03: inline small schemas to avoid a model round
// trip per lookup and defer bulky direct definitions through the same catalog.
// Large input schemas retain describe and the existing output budget.
const MAX_INLINE_SCHEMA_CHARS = 2_000;
// Engineering choice, 2026-09-10: two catalog corrections per request.
// Missing fields/lookups may recover; unavailable actions stay fail-fast.
const MAX_CATALOG_CORRECTIONS = 2;
const MAX_INDEXED_PARAMETERS = 8;
const MAX_INDEX_SUMMARY_CHARS = 100;
const CATALOG_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: NAME,
    description:
      'Run additional permitted tools through this catalog even when their own function schemas are not directly exposed. action=list searches with query and offset and returns small input schemas in parameters; use action=call next with the exact name and matching arguments. Use action=describe only when the input schema is missing or unclear. Use keywords for the task, not a guessed tool name. If an exact name and its parameters are already known, skip discovery. Skills are instruction packages: discover them with skills_list, not a tool named after the skill. Calls keep normal permissions and approvals.',
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
            'Exact tool name, required for describe or call. Omit for list.',
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

/** The first sentence of a tool's description, without the MCP server tag. */
function indexSummary(description: string): string {
  const text = description.replace(/^\[MCP [^\]]*\]\s*/, '').trim();
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > MAX_INDEX_SUMMARY_CHARS
    ? `${sentence.slice(0, MAX_INDEX_SUMMARY_CHARS - 1)}…`
    : sentence;
}

class CatalogArgumentError extends Error {}

export class ToolCatalog {
  readonly tools: ToolDefinition[];
  private readonly byName: Map<string, ToolDefinition>;
  private readonly starters: Set<string>;
  private corrections = 0;
  private readonly validators = new Map<
    string,
    ReturnType<AjvJsonSchemaValidator['getValidator']>
  >();

  /**
   * Expose small connector schemas directly; defer overflow and bulky tools.
   * Returns null when none of the named tools is available, preserving the
   * plain tool array for requests without deferred connectors.
   */
  static deferring(
    availableTools: ToolDefinition[],
    deferredTools: ReadonlySet<string>,
    isReviewedRead: (name: string) => boolean,
  ): ToolCatalog | null {
    const names = availableTools.map((tool) => tool.function.name);
    if (!names.some((name) => deferredTools.has(name))) return null;
    let budget = MAX_SCHEMA_CHARS;
    const starters = new Set(
      availableTools
        .filter(
          (tool) =>
            !deferredTools.has(tool.function.name) &&
            JSON.stringify(tool).length <= MAX_INLINE_SCHEMA_CHARS,
        )
        .map((tool) => tool.function.name),
    );
    // Engineering choice, 2026-10-03: spend the existing directory budget on
    // complete small connector definitions first, avoiding catalog round trips.
    for (const tool of availableTools
      .filter(
        (tool) =>
          deferredTools.has(tool.function.name) &&
          isReviewedRead(tool.function.name),
      )
      .sort(
        (a, b) =>
          JSON.stringify(a).length - JSON.stringify(b).length ||
          a.function.name.localeCompare(b.function.name),
      )) {
      const size = JSON.stringify(tool).length;
      if (size > MAX_INLINE_SCHEMA_CHARS || size > budget) continue;
      starters.add(tool.function.name);
      budget -= size;
    }
    const catalog = new ToolCatalog(
      availableTools,
      starters,
      false,
      'Additional tools, including connected MCP servers, not exposed as direct functions',
    );
    catalog.indexDeferred = true;
    catalog.indexBudget = budget;
    return catalog;
  }

  private indexDeferred = false;
  private indexBudget = MAX_SCHEMA_CHARS;

  constructor(
    availableTools: ToolDefinition[],
    starterTools?: string[] | ReadonlySet<string>,
    discoveryDisabled = false,
    private readonly deferredLabel = 'Additional permitted tools',
  ) {
    if (availableTools.some((tool) => tool.function.name === NAME))
      throw new Error('The tool_catalog name is reserved for discovery.');
    this.byName = new Map(
      availableTools.map((tool) => [tool.function.name, tool]),
    );
    // A Set is a resolved selection; an array is operator input to validate.
    this.starters =
      starterTools instanceof Set
        ? new Set(starterTools)
        : new Set(
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
      '## Tool call boundary',
      names.length
        ? `Directly exposed functions in this request are ${names.join(names.length === 2 ? ' and ' : ', ')}.`
        : 'No functions are exposed in this request.',
      directory
        ? `${this.deferredLabel} are available through tool_catalog. Execute them with action=call, their exact name in name, and their parameters in arguments; their own schemas do not need to be directly exposed.`
        : '',
      directory && this.indexDeferred ? this.deferredIndex() : '',
      'Skills are instruction packages, not tool functions. Reading a SKILL.md provides workflow instructions; it does not register tools or grant permissions.',
      directory && this.byName.has('read') && !names.includes('read')
        ? 'To read a known skill file, call tool_catalog with {"action":"call","name":"read","arguments":{"path":"the skill location"}}. Never emit a direct read call: it is not an exposed function.'
        : '',
      directory && this.byName.has('bash') && !names.includes('bash')
        ? 'To run a known command from skill instructions, call tool_catalog with {"action":"call","name":"bash","arguments":{"command":"the command"}}. Never emit a direct bash call: it is not an exposed function.'
        : '',
      directory && this.byName.has('skills_list')
        ? 'Skill discovery is staged: search skills_list summaries, request details with the exact skill name, then execute the returned next call to read its instructions. Search results are not skill instructions. Follow next.name and next.arguments exactly; discovery does not expose additional functions.'
        : '',
      directory
        ? 'Discover only what is missing: list when the tool name is unknown, describe when its parameters are unknown, then call. Reuse schemas and skill instructions already returned in this request; do not repeat discovery before each action. The directory can reject tools that are unavailable or blocked.'
        : 'Tool discovery is not exposed. Do not claim access to any additional tools.',
      directory
        ? 'For catalog execution, the function name is tool_catalog and the target tool goes in its name argument. Listing or describing a tool does not add a directly callable function.'
        : 'Direct function calls use the names in the supplied schemas.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Each deferred tool as `name(param, optional?): first sentence`. */
  private deferredIndex(): string {
    const deferred = [...this.byName.values()].filter(
      (tool) => !this.starters.has(tool.function.name),
    );
    // Reserve names before schemas, so large early schemas cannot hide later
    // tools. Spend the remaining text budget on complete, smallest schemas.
    let budget = this.indexBudget;
    const entries: { summary: string; schema: string; inline: boolean }[] = [];
    for (const tool of deferred) {
      const parameters = tool.function.parameters;
      const required = new Set(parameters.required ?? []);
      const names = Object.keys(parameters.properties ?? {});
      const shown = names
        .slice(0, MAX_INDEXED_PARAMETERS)
        .map((name) => (required.has(name) ? name : `${name}?`));
      if (names.length > MAX_INDEXED_PARAMETERS) shown.push('…');
      const summary = `- ${tool.function.name}(${shown.join(', ')}): ${indexSummary(tool.function.description)}`;
      if (summary.length + 1 > budget) break;
      budget -= summary.length + 1;
      entries.push({
        summary,
        schema: JSON.stringify(parameters),
        inline: false,
      });
    }
    for (const entry of [...entries].sort(
      (a, b) => a.schema.length - b.schema.length,
    )) {
      const size = entry.schema.length + '\n  parameters: '.length;
      if (entry.schema.length > MAX_INLINE_SCHEMA_CHARS || size > budget)
        continue;
      entry.inline = true;
      budget -= size;
    }
    const lines = entries.map(({ summary, schema, inline }) =>
      inline ? `${summary}\n  parameters: ${schema}` : summary,
    );
    const more = deferred.length - entries.length;
    return [
      `Tools reachable through tool_catalog (${more === 0 ? 'complete directory' : 'partial directory'}; ? marks optional parameters). Inline parameters are the input schema: use action=call with name and matching arguments without listing or describing first. Describe only missing or unclear schemas.${more === 0 ? ' All deferred names are shown; do not list to check for other tools.' : ''} Batch independent identifiers within the tool limits. If results are truncated, inspect missing relevant records before answering.`,
      ...lines,
      more > 0 ? `…and ${more} more: find them with action=list.` : '',
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
    const args = readArgs(call.function.arguments);
    if (call.function.name !== NAME) {
      this.requireTool(call.function.name);
      return call;
    }
    if (!this.tools.some((tool) => tool.function.name === NAME))
      throw new Error('Tool discovery is not available in this request.');
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
        throw new CatalogArgumentError(
          'Tool catalog describe requires an exact tool name.',
        );
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
          'This tool schema cannot be validated for catalog discovery. No action was executed.',
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
      output: `Error: ${error.message} No tool in this batch was executed. Correct the tool_catalog arguments and retry. describe requires name; call requires name and arguments matching the tool schema.`,
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
          description: `Execute ${tool.function.name} using action="call", name="${tool.function.name}", and arguments matching the schema below. Use action="call" next; this schema remains valid for the request. ${tool.function.description}`,
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
              'Error: This tool schema is too large for catalog discovery. Use a smaller tool or a model with a larger context.',
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
    const result = {
      tools: page.map((tool) => {
        const parameters =
          JSON.stringify(tool.function.parameters).length <=
          MAX_INLINE_SCHEMA_CHARS
            ? tool.function.parameters
            : undefined;
        return {
          name: tool.function.name,
          description: tool.function.description.slice(0, 160),
          required: (tool.function.parameters.required ?? []).slice(0, 16),
          parameters,
          next: parameters
            ? undefined
            : {
                name: NAME,
                arguments: { action: 'describe', name: tool.function.name },
              },
        };
      }),
      total: matches.length,
      availableCount:
        this.byName.size -
        [...this.byName.keys()].filter((name) => this.starters.has(name))
          .length,
      hint: matches.length
        ? 'Use tool_catalog action=call with the exact name and arguments matching parameters. When parameters are absent, follow next to describe the schema. Only supplied function names are directly callable.'
        : 'No keyword matches. Try fewer keywords or omit query to browse the permitted tools. Skill names are not tool names; use skills_list for skill discovery.',
      nextOffset:
        offset + page.length < matches.length ? offset + page.length : null,
    };
    for (
      let index = result.tools.length - 1;
      index >= 0 && JSON.stringify(result).length > MAX_SCHEMA_CHARS;
      index -= 1
    ) {
      const entry = result.tools[index];
      entry.parameters = undefined;
      entry.next = {
        name: NAME,
        arguments: { action: 'describe', name: entry.name },
      };
    }
    return {
      output: JSON.stringify(result),
      isError: false,
    };
  }
}
