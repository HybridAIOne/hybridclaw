import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { ToolDefinition } from './types.js';

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

export function executeTool(name: string, argsJson: string): string {
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
];
