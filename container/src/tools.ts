import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { ScheduleSideEffect, ToolDefinition } from './types.js';
import { webFetch } from './web-fetch.js';

// --- Side-effect accumulator for host-processed actions ---

type ScheduledTaskInfo = { id: number; cronExpr: string; runAt: string | null; everyMs: number | null; prompt: string; enabled: number; lastRun: string | null; createdAt: string };

let pendingSchedules: ScheduleSideEffect[] = [];
let injectedTasks: ScheduledTaskInfo[] = [];

export function resetSideEffects(): void {
  pendingSchedules = [];
}

export function getPendingSideEffects(): { schedules?: ScheduleSideEffect[] } | undefined {
  if (pendingSchedules.length === 0) return undefined;
  return { schedules: pendingSchedules };
}

export function setScheduledTasks(tasks: ScheduledTaskInfo[] | undefined): void {
  injectedTasks = tasks || [];
}

const MAX_OUTPUT_LINES = 6;
const MAX_LINE_LENGTH = 200;

function abbreviate(text: string): string {
  const lines = text.split('\n');
  const truncated = lines.slice(0, MAX_OUTPUT_LINES).map((line) =>
    line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '...' : line
  );
  if (lines.length > MAX_OUTPUT_LINES) {
    truncated.push(`... (${lines.length - MAX_OUTPUT_LINES} more lines)`);
  }
  return truncated.join('\n');
}

function safeJoin(userPath: string): string {
  // Strip leading slashes so path.resolve doesn't ignore the base
  return path.resolve('/workspace', userPath.replace(/^\/+/, ''));
}

export async function executeTool(name: string, argsJson: string): Promise<string> {
  try {
    const args = JSON.parse(argsJson);

    switch (name) {
      case 'read': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        return abbreviate(content);
      }

      case 'write': {
        const filePath = safeJoin(args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.contents);
        return `Wrote ${args.contents.length} bytes to ${args.path}`;
      }

      case 'edit': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
        let content = fs.readFileSync(filePath, 'utf-8');
        const count = args.count || 1;
        for (let i = 0; i < count; i++) {
          const idx = content.indexOf(args.old);
          if (idx === -1) {
            if (i === 0) return `Error: Text not found in ${args.path}`;
            break;
          }
          content = content.slice(0, idx) + args.new + content.slice(idx + args.old.length);
        }
        fs.writeFileSync(filePath, content);
        return `Edited ${args.path} (${count} replacement${count > 1 ? 's' : ''})`;
      }

      case 'delete': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
        fs.unlinkSync(filePath);
        return `Deleted ${args.path}`;
      }

      case 'glob': {
        const pattern = args.pattern;
        try {
          // Use find as a simple glob implementation
          const cmd = `find /workspace -path "${pattern.replace(/\*/g, '*')}" -type f 2>/dev/null | head -50`;
          const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
          if (!result.trim()) return 'No files found.';
          // Convert absolute paths to relative
          const files = result.trim().split('\n').map((f) => f.replace('/workspace/', ''));
          return abbreviate(files.join('\n'));
        } catch {
          return 'No files found.';
        }
      }

      case 'grep': {
        const searchPath = args.path ? safeJoin(args.path) : '/workspace';
        try {
          const cmd = `rg --no-heading --line-number "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -30`;
          const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
          if (!result.trim()) return 'No matches found.';
          // Convert absolute paths to relative
          return abbreviate(result.replace(/\/workspace\//g, ''));
        } catch {
          return 'No matches found.';
        }
      }

      case 'bash': {
        try {
          // Strip secrets from subprocess environment (belt-and-suspenders)
          const cleanEnv = { ...process.env };
          delete cleanEnv.HYBRIDAI_API_KEY;
          const result = execSync(args.command, {
            timeout: 30000,
            encoding: 'utf-8',
            cwd: '/workspace',
            maxBuffer: 1024 * 1024,
            env: cleanEnv,
          });
          return abbreviate(result || '(no output)');
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string };
          return `Error: ${execErr.stderr || execErr.message || 'Command failed'}`;
        }
      }

      case 'web_fetch': {
        const result = await webFetch({
          url: args.url,
          extractMode: args.extractMode,
          maxChars: args.maxChars,
        });
        const header = result.title ? `# ${result.title}\n\n` : '';
        const meta = `[${result.extractor}] ${result.finalUrl} (${result.status}, ${result.tookMs}ms)`;
        return `${meta}\n\n${header}${result.text}`;
      }

      case 'cron': {
        const action = args.action;

        if (action === 'list') {
          if (injectedTasks.length === 0) return 'No scheduled tasks.';
          const lines = injectedTasks.map((t) => {
            let schedule: string;
            if (t.runAt) schedule = `at ${t.runAt}`;
            else if (t.everyMs) {
              const secs = t.everyMs / 1000;
              if (secs < 120) schedule = `every ${secs}s`;
              else if (secs < 7200) schedule = `every ${Math.round(secs / 60)}m`;
              else schedule = `every ${Math.round(secs / 3600)}h`;
            } else schedule = t.cronExpr;
            const status = t.enabled ? 'enabled' : 'disabled';
            return `#${t.id} [${status}] ${schedule} — ${t.prompt}`;
          });
          return lines.join('\n');
        }

        if (action === 'add') {
          if (!args.prompt) return 'Error: prompt is required';

          if (args.at) {
            const runAt = new Date(args.at);
            if (isNaN(runAt.getTime())) return `Error: invalid ISO-8601 timestamp: ${args.at}`;
            if (runAt.getTime() <= Date.now()) return `Error: timestamp must be in the future: ${args.at}`;
            pendingSchedules.push({ action: 'add', runAt: runAt.toISOString(), prompt: args.prompt });
            return `Scheduled one-shot task at ${runAt.toISOString()}: ${args.prompt}`;
          }

          if (args.cron) {
            pendingSchedules.push({ action: 'add', cronExpr: args.cron, prompt: args.prompt });
            return `Scheduled recurring task with cron "${args.cron}": ${args.prompt}`;
          }

          if (args.every) {
            const secs = Number(args.every);
            if (isNaN(secs) || secs < 10) return 'Error: "every" must be a number of seconds >= 10';
            const everyMs = Math.round(secs * 1000);
            pendingSchedules.push({ action: 'add', everyMs, prompt: args.prompt });
            return `Scheduled interval task every ${secs}s: ${args.prompt}`;
          }

          return 'Error: provide "at" (ISO-8601 timestamp), "cron" (cron expression), or "every" (seconds)';
        }

        if (action === 'remove') {
          if (!args.taskId) return 'Error: taskId is required';
          pendingSchedules.push({ action: 'remove', taskId: args.taskId });
          return `Scheduled removal of task #${args.taskId}`;
        }

        return `Error: unknown cron action "${action}". Use "list", "add", or "remove".`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file and return its contents',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write contents to a file, overwriting if it exists',
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
      description: 'Replace text in a file using old/new strings',
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
      description: 'Run a shell command and return stdout/stderr',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
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
          extractMode: {
            type: 'string',
            description: 'Extraction mode: "markdown" (default) or "text"',
          },
          maxChars: {
            type: 'number',
            description: 'Maximum characters to return (default 50000, max 50000)',
          },
        },
        required: ['url'],
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
