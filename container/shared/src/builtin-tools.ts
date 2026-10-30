/**
 * Built-in tool manifest: the one list of tools the container defines itself.
 *
 * Every container `TOOL_DEFINITIONS` entry appears here exactly once, in its
 * display group (tests/builtin-tools.test.ts fails on drift). The gateway's
 * tool catalog, CLI enable/disable and prompt summary derive from it.
 *
 * NOT plugin tools (the plugin registry owns those), MCP tools, or the
 * per-request `tool_catalog` discovery tool.
 */

export interface BuiltinTool {
  readonly name: string;
  readonly group: string;
  /** May overlap any other call in a batch; see container tool-parallelism. */
  readonly parallelSafe?: true;
}

// Engineering choice, 2026-09-26: `parallelSafe` is hermes-agent's read-only
// allowlist mapped to HybridClaw's tools. Tools that write workspace artifacts
// (diagram_create) stay barriers; path-scoped file tools batch by path instead.
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  { name: 'read', group: 'Files' },
  { name: 'write', group: 'Files' },
  { name: 'edit', group: 'Files' },
  { name: 'delete', group: 'Files' },
  { name: 'glob', group: 'Files' },
  { name: 'grep', group: 'Files' },
  { name: 'bash', group: 'Shell' },
  { name: 'web_search', group: 'Web', parallelSafe: true },
  { name: 'web_fetch', group: 'Web', parallelSafe: true },
  { name: 'web_extract', group: 'Web', parallelSafe: true },
  { name: 'http_request', group: 'Web' },
  { name: 'browser_navigate', group: 'Browser' },
  { name: 'browser_snapshot', group: 'Browser' },
  { name: 'browser_click', group: 'Browser' },
  { name: 'browser_type', group: 'Browser' },
  { name: 'browser_secret_type', group: 'Browser' },
  { name: 'browser_sign_in', group: 'Browser' },
  { name: 'browser_take_over', group: 'Browser' },
  { name: 'browser_await_two_factor', group: 'Browser' },
  { name: 'browser_resume_interaction', group: 'Browser' },
  { name: 'browser_upload', group: 'Browser' },
  { name: 'browser_press', group: 'Browser' },
  { name: 'browser_scroll', group: 'Browser' },
  { name: 'browser_back', group: 'Browser' },
  { name: 'browser_screenshot', group: 'Browser' },
  { name: 'browser_pdf', group: 'Browser' },
  { name: 'browser_vision', group: 'Browser' },
  { name: 'browser_get_images', group: 'Browser' },
  { name: 'browser_console', group: 'Browser' },
  { name: 'browser_network', group: 'Browser' },
  { name: 'browser_evaluate', group: 'Browser' },
  { name: 'browser_downloads', group: 'Browser' },
  { name: 'browser_close', group: 'Browser' },
  { name: 'message', group: 'Communication' },
  { name: 'draft_email', group: 'Communication' },
  { name: 'inbox_cleanup', group: 'Communication' },
  { name: 'estimate_cost', group: 'Communication' },
  { name: 'call_user', group: 'Communication' },
  { name: 'cron', group: 'Scheduling' },
  { name: 'trigger', group: 'Scheduling' },
  { name: 'todo', group: 'Scheduling' },
  { name: 'track', group: 'Scheduling' },
  { name: 'delegate', group: 'Delegation' },
  { name: 'memory', group: 'Memory' },
  { name: 'session_search', group: 'Memory', parallelSafe: true },
  { name: 'preferences', group: 'Memory' },
  { name: 'work', group: 'Memory' },
  { name: 'proof', group: 'Memory' },
  { name: 'skills_list', group: 'Skills', parallelSafe: true },
  { name: 'device_data', group: 'Phone Data', parallelSafe: true },
  { name: 'show_widget', group: 'App Widgets' },
  { name: 'draft_transfer', group: 'App Widgets' },
  { name: 'show_dashboard', group: 'App Widgets' },
  { name: 'show_slide_samples', group: 'App Widgets' },
  { name: 'vision_analyze', group: 'Vision', parallelSafe: true },
  { name: 'diagram_create', group: 'Diagrams' },
  { name: 'diagram_update', group: 'Diagrams' },
  { name: 'diagram_validate', group: 'Diagrams' },
];
