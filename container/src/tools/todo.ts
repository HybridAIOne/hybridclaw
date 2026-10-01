/**
 * The `todo` tool — the agent's door to the user's todo list, which lives on
 * the gateway (`POST /api/todo`) so it outlives the worker and apps see the
 * same list. A check-off through this tool is recorded as the agent's.
 *
 * NOT `cron`: a todo is something the user does; cron has the agent act.
 */
import type { ToolDefinition } from '../types.js';

export const TODO_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'todo',
    description:
      'Keep the user’s todo list: one-off todos and repeating ones (habits such as "30 minutes of Chinese" daily) that open again every day and count a streak. Actions:\n' +
      '- "list": every todo with today’s state\n' +
      '- "add": needs "title"; optional "repeat", "due", "remind"\n' +
      '- "done" / "undo": check a todo off, or reopen it, for today or a "date" in the past week\n' +
      '- "edit": change "title", "repeat", "due" or "remind" of todo "id"\n' +
      '- "remove": delete todo "id"\n' +
      'Use a todo when the user wants to do something themselves and have it tracked or reminded; use cron when you should act at a time. When the user says they did something on the list, or you see clear evidence of it (a workout in their health data, a finished calendar event), check it off without asking: they can undo it. Never check off what they only plan to do.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '"list", "add", "done", "undo", "edit" or "remove"',
        },
        id: { type: 'number', description: 'Todo id, from "list"' },
        title: {
          type: 'string',
          description: 'Short title, e.g. "Chinese · 30 min"',
        },
        repeat: {
          type: 'string',
          description:
            '"daily", "weekdays", days such as "mon,wed,fri", or "none" for a one-off',
        },
        due: {
          type: 'string',
          description: 'Due date of a one-off, YYYY-MM-DD, or "none"',
        },
        remind: {
          type: 'string',
          description:
            'Local time HH:MM to remind the user while the todo is still open, or "off"',
        },
        date: {
          type: 'string',
          description:
            'YYYY-MM-DD for "done"/"undo" on an earlier day; omit for today',
        },
      },
      required: ['action'],
    },
  },
};

export async function runTodoTool(
  args: Record<string, unknown>,
  gateway: { baseUrl: string; apiToken: string; sessionId: string },
): Promise<{ ok: boolean; text: string }> {
  const base = gateway.baseUrl.replace(/\/+$/, '');
  if (!base) {
    return {
      ok: false,
      text: 'Error: todos are unavailable because gatewayBaseUrl is not configured.',
    };
  }
  let response: Response;
  try {
    response = await fetch(`${base}/api/todo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gateway.apiToken
          ? { Authorization: `Bearer ${gateway.apiToken}` }
          : {}),
      },
      body: JSON.stringify({ ...args, sessionId: gateway.sessionId }),
    });
  } catch (err) {
    return {
      ok: false,
      text: `Error: todo request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const rawText = await response.text();
  let parsed: { ok?: unknown; result?: unknown; error?: unknown } | null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }
  if (response.ok && parsed?.ok === true && typeof parsed.result === 'string') {
    return { ok: true, text: parsed.result };
  }
  const detail =
    typeof parsed?.error === 'string' && parsed.error.trim()
      ? parsed.error
      : rawText || `HTTP ${response.status}`;
  return { ok: false, text: `Error: ${detail}` };
}
