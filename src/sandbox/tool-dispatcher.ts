import type { SandboxClient } from './client.js';
import { guardCommand, isToolAllowed } from './security.js';
import type { ToolCall, ToolResult } from './types.js';

// --- Bash output formatting ---

const BASH_MAX_OUTPUT_LINES = 400;
const BASH_MAX_OUTPUT_BYTES = 128 * 1024;

function formatBashOutput(content: string): string {
  const raw = content || '(no output)';
  const lines = raw.split('\n');
  if (lines.length <= BASH_MAX_OUTPUT_LINES && Buffer.byteLength(raw, 'utf-8') <= BASH_MAX_OUTPUT_BYTES) {
    return raw;
  }
  const truncated = lines.slice(0, BASH_MAX_OUTPUT_LINES).join('\n');
  return `${truncated}\n\n[Output truncated after ${BASH_MAX_OUTPUT_LINES}/${lines.length} lines]`;
}

// --- Main dispatcher ---

export async function dispatchTool(
  toolCall: ToolCall,
  sandboxId: string,
  client: SandboxClient,
  opts: {
    allowedTools?: string[];
    onProgress?: (phase: 'start' | 'finish', preview?: string, durationMs?: number) => void;
    abortSignal?: AbortSignal;
  } = {},
): Promise<ToolResult> {
  const { name, args, id: toolCallId } = toolCall;

  // Tool allowlist enforcement
  if (!isToolAllowed(name, opts.allowedTools)) {
    return { toolCallId, content: `Error: tool "${name}" is not in the allowed tools list.`, isError: true };
  }

  opts.onProgress?.('start', truncatePreview(JSON.stringify(args)));
  const startMs = Date.now();

  let result: ToolResult;
  try {
    result = await dispatchToolInner(name, args, sandboxId, client, opts);
  } catch (err) {
    result = {
      toolCallId,
      content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  result.toolCallId = toolCallId;
  opts.onProgress?.('finish', undefined, Date.now() - startMs);
  return result;
}

function truncatePreview(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max) + '...';
}

async function dispatchToolInner(
  name: string,
  args: Record<string, unknown>,
  sandboxId: string,
  client: SandboxClient,
  opts: {
    onProgress?: (phase: 'start' | 'finish', preview?: string, durationMs?: number) => void;
    abortSignal?: AbortSignal;
  },
): Promise<ToolResult> {
  const ok = (content: string): ToolResult => ({ toolCallId: '', content });
  const err = (content: string): ToolResult => ({ toolCallId: '', content, isError: true });

  switch (name) {
    // --- File I/O tools ---

    case 'read': {
      const path = String(args.path || '');
      if (!path) return err('Error: path is required');
      try {
        const content = await client.readFile(sandboxId, path);
        return ok(content);
      } catch (e) {
        return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    case 'write': {
      const path = String(args.path || '');
      const contents = String(args.contents ?? args.content ?? '');
      if (!path) return err('Error: path is required');
      await client.writeFile(sandboxId, path, contents);
      return ok(`Wrote ${contents.length} bytes to ${path}`);
    }

    case 'edit': {
      const path = String(args.path || '');
      const oldStr = String(args.old ?? '');
      const newStr = String(args.new ?? '');
      if (!path) return err('Error: path is required');
      if (!oldStr) return err('Error: old is required');

      let content: string;
      try {
        content = await client.readFile(sandboxId, path);
      } catch (e) {
        return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }

      const count = typeof args.count === 'number' ? args.count : 1;
      let replaced = 0;
      for (let i = 0; i < count; i++) {
        const idx = content.indexOf(oldStr);
        if (idx === -1) {
          if (i === 0) return err(`Error: Text not found in ${path}`);
          break;
        }
        content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        replaced++;
      }

      await client.writeFile(sandboxId, path, content);
      return ok(`Edited ${path} (${replaced} replacement${replaced > 1 ? 's' : ''})`);
    }

    case 'delete': {
      const path = String(args.path || '');
      if (!path) return err('Error: path is required');
      try {
        await client.deleteFile(sandboxId, path);
        return ok(`Deleted ${path}`);
      } catch (e) {
        return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- Search tools ---

    case 'glob': {
      const pattern = String(args.pattern || '');
      if (!pattern) return err('Error: pattern is required');
      const basePath = String(args.path || '/workspace');
      const cmd = `find ${basePath} -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -200`;
      const { stdout } = await client.runProcess(sandboxId, { code: cmd, timeoutMs: 10_000 });
      return ok(stdout.trim() || 'No files found.');
    }

    case 'grep': {
      const pattern = String(args.pattern || '');
      if (!pattern) return err('Error: pattern is required');
      const searchPath = String(args.path || '/workspace');
      const escaped = pattern.replace(/"/g, '\\"');
      const cmd = `rg --no-heading --line-number "${escaped}" "${searchPath}" 2>/dev/null | head -30`;
      const { stdout } = await client.runProcess(sandboxId, { code: cmd, timeoutMs: 10_000 });
      return ok(stdout.trim() || 'No matches found.');
    }

    // --- Bash ---

    case 'bash': {
      const command = String(args.command || '');
      if (!command) return err('Error: command is required');

      const blocked = guardCommand(command);
      if (blocked) return err(blocked);

      let stdout = '';
      let stderr = '';
      const { exitCode } = await client.runProcessStream(
        sandboxId,
        command,
        (chunk) => {
          if (chunk.type === 'stdout' && chunk.text) {
            stdout += chunk.text;
            opts.onProgress?.('start', truncatePreview(chunk.text));
          } else if (chunk.type === 'stderr' && chunk.text) {
            stderr += chunk.text;
          }
        },
        opts.abortSignal,
      );

      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      const formatted = formatBashOutput(combined || '(no output)');
      if (exitCode !== 0) {
        return err(`Exit code ${exitCode}\n\n${formatted}`);
      }
      return ok(formatted);
    }

    // --- Memory ---

    case 'memory': {
      const action = String(args.action || 'read').toLowerCase();
      const filePath = resolveMemoryPath(args);

      if (action === 'read') {
        try {
          const content = await client.readFile(sandboxId, filePath);
          return ok(`${filePath}\n\n${content || '(empty)'}`);
        } catch {
          return ok(`${filePath}\n\n(empty)`);
        }
      }

      if (action === 'write') {
        const content = String(args.content ?? '');
        await client.writeFile(sandboxId, filePath, content);
        return ok(`Wrote ${content.length} chars to ${filePath}`);
      }

      if (action === 'append') {
        const content = String(args.content ?? '').trim();
        if (!content) return err('Error: content is required for memory append');
        let existing = '';
        try {
          existing = await client.readFile(sandboxId, filePath);
        } catch {
          // File doesn't exist yet
        }
        let next = existing.replace(/\s+$/, '');
        if (next.length > 0) next += '\n\n';
        next += `${content}\n`;
        await client.writeFile(sandboxId, filePath, next);
        return ok(`Appended ${content.length} chars to ${filePath}`);
      }

      if (action === 'list') {
        const { stdout } = await client.runProcess(sandboxId, {
          code: 'find /workspace -maxdepth 2 -name "MEMORY.md" -o -name "USER.md" -o -path "*/memory/*.md" 2>/dev/null',
          timeoutMs: 5_000,
        });
        return ok(stdout.trim() || 'No memory files found.');
      }

      if (action === 'search') {
        const query = String(args.query || '');
        if (!query) return err('Error: query is required for memory search');
        const { stdout } = await client.runProcess(sandboxId, {
          code: `grep -rn "${query.replace(/"/g, '\\"')}" /workspace/MEMORY.md /workspace/USER.md /workspace/memory/ 2>/dev/null | head -40`,
          timeoutMs: 5_000,
        });
        return ok(stdout.trim() || `No memory matches for "${query}".`);
      }

      return err(`Error: unknown memory action "${action}".`);
    }

    // --- Web fetch (runs inside sandbox via egress-proxy) ---

    case 'web_fetch': {
      const url = String(args.url || '');
      if (!url) return err('Error: url is required');
      const script = `
        try {
          const r = await fetch(${JSON.stringify(url)});
          const t = await r.text();
          process.stdout.write(t.slice(0, 50000));
        } catch(e) { process.stderr.write(String(e)); process.exit(1); }
      `;
      const { stdout, stderr, exitCode } = await client.runProcess(sandboxId, {
        code: `node -e ${shellEscape(script)}`,
        timeoutMs: 30_000,
      });
      if (exitCode !== 0) return err(`web_fetch failed: ${stderr}`);
      return ok(stdout);
    }

    // --- Session search ---

    case 'session_search': {
      const query = String(args.query || '');
      if (!query) return err('Error: query is required');
      const escaped = query.replace(/"/g, '\\"');
      const { stdout } = await client.runProcess(sandboxId, {
        code: `grep -r "${escaped}" /workspace/.session-transcripts/ 2>/dev/null | head -100`,
        timeoutMs: 10_000,
      });
      return ok(stdout.trim() || 'No session matches found.');
    }

    // --- Delegation (sentinel — handled by agent loop) ---

    case 'delegate': {
      return {
        toolCallId: '',
        content: '__DELEGATE__:' + JSON.stringify(args),
        isDelegate: true,
      };
    }

    // --- Cron (side-effect sentinel — handled by agent loop) ---

    case 'cron': {
      return {
        toolCallId: '',
        content: '__CRON__:' + JSON.stringify(args),
      };
    }

    // --- Browser tools (run via agent-browser in sandbox) ---

    case 'browser_navigate': {
      const url = String(args.url || '');
      if (!url) return err('Error: url is required');
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json open ${shellEscape(url)}`,
        timeoutMs: 60_000,
      });
      if (exitCode !== 0) return err(`browser_navigate failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_snapshot': {
      const flags = args.full === true ? '' : ' -i -c';
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json snapshot${flags}`,
        timeoutMs: 45_000,
      });
      if (exitCode !== 0) return err(`browser_snapshot failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_click': {
      const ref = ensureRef(args.ref);
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json click ${shellEscape(ref)}`,
        timeoutMs: 30_000,
      });
      if (exitCode !== 0) return err(`browser_click failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_type': {
      const ref = ensureRef(args.ref);
      const text = String(args.text || '');
      if (!text) return err('Error: text is required');
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json fill ${shellEscape(ref)} ${shellEscape(text)}`,
        timeoutMs: 30_000,
      });
      if (exitCode !== 0) return err(`browser_type failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_press': {
      const key = String(args.key || '').trim();
      if (!key) return err('Error: key is required');
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json press ${shellEscape(key)}`,
        timeoutMs: 30_000,
      });
      if (exitCode !== 0) return err(`browser_press failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_scroll': {
      const direction = String(args.direction || '').toLowerCase();
      if (direction !== 'up' && direction !== 'down') return err('Error: direction must be "up" or "down"');
      const pixels = typeof args.pixels === 'number' ? args.pixels : 800;
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json scroll ${direction} ${pixels}`,
        timeoutMs: 30_000,
      });
      if (exitCode !== 0) return err(`browser_scroll failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_back': {
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: 'agent-browser --json back',
        timeoutMs: 30_000,
      });
      if (exitCode !== 0) return err(`browser_back failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_screenshot': {
      const outPath = shellEscape(String(args.path || `browser-${Date.now()}.png`));
      const fullFlag = args.fullPage === true ? '--full ' : '';
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json screenshot ${fullFlag}${outPath}`,
        timeoutMs: 60_000,
      });
      if (exitCode !== 0) return err(`browser_screenshot failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_pdf': {
      const outPath = shellEscape(String(args.path || `browser-${Date.now()}.pdf`));
      const { stdout, exitCode } = await client.runProcess(sandboxId, {
        code: `agent-browser --json pdf ${outPath}`,
        timeoutMs: 60_000,
      });
      if (exitCode !== 0) return err(`browser_pdf failed: ${stdout}`);
      return ok(stdout);
    }

    case 'browser_close': {
      const { stdout } = await client.runProcess(sandboxId, {
        code: 'agent-browser --json close',
        timeoutMs: 15_000,
      });
      return ok(stdout || '{"closed": true}');
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}

// --- Helpers ---

/** Shell-escape a string by wrapping in single quotes (with internal quote escaping). */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function ensureRef(raw: unknown): string {
  const ref = String(raw || '').trim();
  if (!ref) throw new Error('ref is required');
  return ref.startsWith('@') ? ref : `@${ref}`;
}

function resolveMemoryPath(args: Record<string, unknown>): string {
  const filePath = String(args.file_path || args.path || '').trim();
  if (filePath) {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\/workspace\//, '').replace(/^\.?\//, '');
    if (/^(MEMORY|USER)\.md$/.test(normalized) || /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(normalized)) {
      return `/workspace/${normalized}`;
    }
  }

  const target = String(args.target || '').trim().toLowerCase();
  if (target === 'user') return '/workspace/USER.md';
  if (target === 'daily') {
    const date = typeof args.date === 'string' ? args.date.trim() : new Date().toISOString().slice(0, 10);
    return `/workspace/memory/${date}.md`;
  }
  return '/workspace/MEMORY.md';
}
