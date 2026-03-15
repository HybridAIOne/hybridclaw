import {
  BROWSER_TOOL_DEFINITIONS as desktopBrowserToolDefinitions,
  executeBrowserTool as executeDesktopBrowserTool,
  setBrowserModelContext as setDesktopBrowserModelContext,
  setBrowserTaskModelPolicies as setDesktopBrowserTaskModelPolicies,
} from './browser/browser-tool.js';
import {
  executeHeadlessBrowserTool,
  HEADLESS_BROWSER_TOOL_DEFINITIONS,
  setHeadlessBrowserModelContext,
  setHeadlessBrowserTaskModelPolicies,
} from './headless-browser-tools.js';
import type { TaskModelPolicies, ToolDefinition } from './types.js';

const DESKTOP_BROWSER_TOOL_NAMES = new Set(['browser_use']);

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...desktopBrowserToolDefinitions.filter(
    (definition) => definition.function.name === 'browser_use',
  ),
  ...HEADLESS_BROWSER_TOOL_DEFINITIONS,
];

export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  if (DESKTOP_BROWSER_TOOL_NAMES.has(name)) {
    return executeDesktopBrowserTool(name, args, sessionId);
  }
  return executeHeadlessBrowserTool(name, args, sessionId);
}

export function setBrowserModelContext(
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio'
    | 'vllm'
    | undefined,
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
  requestHeaders?: Record<string, string>,
): void {
  setDesktopBrowserModelContext(
    provider,
    baseUrl,
    apiKey,
    model,
    chatbotId,
    requestHeaders,
  );
  setHeadlessBrowserModelContext(
    provider,
    baseUrl,
    apiKey,
    model,
    chatbotId,
    requestHeaders,
  );
}

export function setBrowserTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): void {
  setDesktopBrowserTaskModelPolicies(taskModels);
  setHeadlessBrowserTaskModelPolicies(taskModels);
}
