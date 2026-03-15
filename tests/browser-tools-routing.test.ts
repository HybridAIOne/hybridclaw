import { afterEach, expect, test, vi } from 'vitest';

const executeDesktopBrowserTool = vi.fn();
const executeHeadlessBrowserTool = vi.fn();
const setDesktopBrowserModelContext = vi.fn();
const setHeadlessBrowserModelContext = vi.fn();
const setDesktopBrowserTaskModelPolicies = vi.fn();
const setHeadlessBrowserTaskModelPolicies = vi.fn();

vi.mock('../container/src/browser/browser-tool.js', () => ({
  BROWSER_TOOL_DEFINITIONS: [
    {
      type: 'function',
      function: {
        name: 'browser_use',
        description: 'desktop browser tool',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: 'legacy wrapper',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ],
  executeBrowserTool: executeDesktopBrowserTool,
  setBrowserModelContext: setDesktopBrowserModelContext,
  setBrowserTaskModelPolicies: setDesktopBrowserTaskModelPolicies,
}));

vi.mock('../container/src/headless-browser-tools.js', () => ({
  HEADLESS_BROWSER_TOOL_DEFINITIONS: [
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: 'headless browser tool',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ],
  executeHeadlessBrowserTool,
  setHeadlessBrowserModelContext,
  setHeadlessBrowserTaskModelPolicies,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

test('routes browser_use to the desktop browser implementation', async () => {
  executeDesktopBrowserTool.mockResolvedValueOnce('desktop');
  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  await expect(
    executeBrowserTool('browser_use', {}, 'session-1'),
  ).resolves.toBe('desktop');
  expect(executeDesktopBrowserTool).toHaveBeenCalledWith(
    'browser_use',
    {},
    'session-1',
  );
  expect(executeHeadlessBrowserTool).not.toHaveBeenCalled();
});

test('routes legacy browser tools to the headless implementation', async () => {
  executeHeadlessBrowserTool.mockResolvedValueOnce('headless');
  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  await expect(
    executeBrowserTool(
      'browser_navigate',
      { url: 'https://example.com' },
      'session-2',
    ),
  ).resolves.toBe('headless');
  expect(executeHeadlessBrowserTool).toHaveBeenCalledWith(
    'browser_navigate',
    { url: 'https://example.com' },
    'session-2',
  );
  expect(executeDesktopBrowserTool).not.toHaveBeenCalled();
});

test('exports browser_use once and keeps legacy headless definitions', async () => {
  const { BROWSER_TOOL_DEFINITIONS } = await import(
    '../container/src/browser-tools.js'
  );

  expect(
    BROWSER_TOOL_DEFINITIONS.filter(
      (definition) => definition.function.name === 'browser_use',
    ),
  ).toHaveLength(1);
  expect(
    BROWSER_TOOL_DEFINITIONS.filter(
      (definition) => definition.function.name === 'browser_navigate',
    ),
  ).toHaveLength(1);
});

test('propagates model context and task model policy updates to both browser stacks', async () => {
  const { setBrowserModelContext, setBrowserTaskModelPolicies } = await import(
    '../container/src/browser-tools.js'
  );

  setBrowserModelContext(
    'hybridai',
    'https://example.com',
    'test-key',
    'gpt-5',
    'bot-1',
    { 'x-test': '1' },
  );
  setBrowserTaskModelPolicies({
    vision: {
      provider: 'hybridai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-5',
      chatbotId: 'bot-1',
      requestHeaders: {},
    },
  });

  expect(setDesktopBrowserModelContext).toHaveBeenCalledTimes(1);
  expect(setHeadlessBrowserModelContext).toHaveBeenCalledTimes(1);
  expect(setDesktopBrowserTaskModelPolicies).toHaveBeenCalledTimes(1);
  expect(setHeadlessBrowserTaskModelPolicies).toHaveBeenCalledTimes(1);
});
