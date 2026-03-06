/**
 * Tool definitions for the LLM agent loop.
 * Ported from container/src/tools.ts TOOL_DEFINITIONS + BROWSER_TOOL_DEFINITIONS.
 */

interface ToolSchemaProperty {
  type: string | string[];
  description?: string;
  items?: ToolSchemaProperty;
  properties?: Record<string, ToolSchemaProperty>;
  required?: string[];
  enum?: string[];
  minItems?: number;
  maxItems?: number;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolSchemaProperty>;
      required: string[];
    };
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read a file and return its contents. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed, default: 1)' },
          limit: { type: 'number', description: 'Maximum number of lines to read before truncation logic (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write contents to a file on disk, overwriting if it exists. Use this for creating new code/program files instead of shell heredocs or code-only replies.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          contents: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Replace text in a file using old/new strings. Use this for file edits instead of shell-based editing (sed/awk/perl in bash).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          old: { type: 'string', description: 'Text to find and replace' },
          new: { type: 'string', description: 'Replacement text' },
          count: { type: 'number', description: 'Number of replacements (default: 1)' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete',
      description: 'Delete a file from the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a regex pattern in files',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: workspace root)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command and return stdout/stderr. Do not use for file creation or file editing; use write/edit tools for file authoring.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeoutMs: { type: 'number', description: 'Optional command timeout in milliseconds (default 240000, max 900000)' },
          timeoutSeconds: { type: 'number', description: 'Optional command timeout in seconds (used when timeoutMs is omitted)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description:
        'Manage durable agent memory files. Supports MEMORY.md, USER.md, and daily files at memory/YYYY-MM-DD.md. Actions: read, append, write, replace, remove, list, search. Memory files are char-bounded to prevent unbounded growth. Use this proactively for durable facts/preferences; do not wait to be explicitly asked to remember important context.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: "read", "append", "write", "replace", "remove", "list", or "search"' },
          file_path: { type: 'string', description: 'Target file path. Allowed: MEMORY.md, USER.md, memory/YYYY-MM-DD.md' },
          target: { type: 'string', description: 'Optional shorthand target: "memory", "user", or "daily"' },
          date: { type: 'string', description: 'Date for target="daily" in YYYY-MM-DD format (defaults to today)' },
          content: { type: 'string', description: 'Text payload for append/write' },
          old_text: { type: 'string', description: 'Existing substring for replace/remove' },
          new_text: { type: 'string', description: 'Replacement text for replace' },
          query: { type: 'string', description: 'Case-insensitive query string for search' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session_search',
      description:
        'Search and summarize historical session transcripts. Returns top matching sessions with concise summaries and key snippets. Use proactively when prior context might be relevant.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query over prior session transcripts' },
          limit: { type: 'number', description: 'Maximum number of sessions to summarize (default 3, max 5)' },
          role_filter: { type: 'string', description: 'Optional comma-separated roles to match (e.g. "user,assistant")' },
          include_current: { type: 'boolean', description: 'Include the current session in results (default false)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL and extract its readable content as markdown or plain text. Works with HTML pages, JSON APIs, and markdown URLs. Use for reading web pages, documentation, API responses, etc.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
          extractMode: { type: 'string', description: 'Extraction mode: "markdown" (default) or "text"' },
          maxChars: { type: 'number', description: 'Maximum characters to return (default 50000, max 50000)' },
        },
        required: ['url'],
      },
    },
  },
  // --- Browser tools ---
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate to an HTTP/HTTPS URL in a browser session. Private/loopback hosts are blocked by default (SSRF guard).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open (http:// or https://)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Return an accessibility-tree snapshot of the current page with element refs usable by browser_click/browser_type.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'If true, request fuller snapshot output (default: false).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element by snapshot ref (example: "@e5").',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference from browser_snapshot.' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input element by snapshot ref (clears then fills).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference from browser_snapshot.' },
          text: { type: 'string', description: 'Text to type.' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: 'Press a keyboard key in the active page (Enter, Tab, Escape, etc.).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Keyboard key name.' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the current page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: 'Scroll direction: "up" or "down".' },
          pixels: { type: 'number', description: 'Optional pixel amount (default: 800).' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Navigate back in browser history.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture a screenshot. Output path is constrained under /workspace/.browser-artifacts for safety.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative output path under .browser-artifacts.' },
          fullPage: { type: 'boolean', description: 'Capture full page when true.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_pdf',
      description: 'Save the current page as PDF. Output path is constrained under /workspace/.browser-artifacts for safety.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative output path under .browser-artifacts.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the current browser session and release associated resources.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  // --- Side-effect tools ---
  {
    type: 'function',
    function: {
      name: 'delegate',
      description:
        'Delegate narrow, self-contained subtasks to background subagents. Use for reasoning-heavy/context-heavy work or independent parallel branches; avoid for trivial single tool calls. Modes: single (`prompt`), parallel (`tasks[]`), chain (`chain[]` with `{previous}`). Never forward the user prompt verbatim. Provide self-contained task context (goal, paths, constraints, expected output). Completion is push-delivered automatically; do not poll/sleep.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description: 'Optional explicit mode: "single", "parallel", or "chain". Inferred automatically when omitted.',
            enum: ['single', 'parallel', 'chain'],
          },
          prompt: { type: 'string', description: 'Single-mode task instructions. Must be self-contained and specific.' },
          label: { type: 'string', description: 'Optional short label for completion messages' },
          model: { type: 'string', description: 'Optional model override for delegated run(s)' },
          tasks: {
            type: 'array',
            description: 'Parallel-mode independent tasks (1-6 items). Each task must be self-contained.',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Task instructions with explicit goal/scope/constraints.' },
                label: { type: 'string', description: 'Optional task label' },
                model: { type: 'string', description: 'Optional per-task model override' },
              },
              required: ['prompt'],
            },
          },
          chain: {
            type: 'array',
            description: 'Chain-mode dependent steps (1-6 items). Use `{previous}` to inject prior step output.',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Step instructions (supports `{previous}`) with expected output.' },
                label: { type: 'string', description: 'Optional step label' },
                model: { type: 'string', description: 'Optional per-step model override' },
              },
              required: ['prompt'],
            },
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cron',
      description:
        'Manage scheduled tasks and reminders. Actions:\n' +
        '- "list": show all scheduled tasks\n' +
        '- "add": create a task. Provide "prompt" plus one of: "at" (ISO-8601 timestamp for one-shot), "cron" (cron expression for cron-based recurring), or "every" (interval in seconds for simple recurring)\n' +
        '- "remove": delete a task by taskId\n' +
        'For relative times like "in 5 minutes", compute the ISO-8601 timestamp and use "at".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform: "list", "add", or "remove"' },
          prompt: { type: 'string', description: 'Task prompt / reminder text (required for "add")' },
          at: { type: 'string', description: 'ISO-8601 timestamp for one-shot schedule (e.g. "2025-01-15T14:30:00Z")' },
          cron: { type: 'string', description: 'Cron expression for recurring schedule (e.g. "0 9 * * *")' },
          every: { type: 'number', description: 'Interval in seconds for simple recurring schedule (minimum 10)' },
          taskId: { type: 'number', description: 'Task ID to remove (required for "remove")' },
        },
        required: ['action'],
      },
    },
  },
];
