import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';

import { expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function writeDemoPlugin(
  rootDir: string,
  options?: {
    requireWorkspaceId?: boolean;
    workspaceDefault?: string;
  },
): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', 'demo-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: demo-plugin',
      'name: Demo Plugin',
      'description: Demo plugin for testing',
      'kind: tool',
      'configSchema:',
      '  type: object',
      '  properties:',
      '    workspaceId:',
      '      type: string',
      ...(options?.workspaceDefault
        ? [`      default: ${options.workspaceDefault}`]
        : []),
      '    autoRecall:',
      '      type: boolean',
      '      default: true',
      ...(options?.requireWorkspaceId === false
        ? []
        : ['  required: [workspaceId]']),
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'demo-plugin',",
      '  register(api) {',
      '    const cfg = api.pluginConfig;',
      '    api.registerMemoryLayer({',
      "      id: 'demo-memory',",
      '      priority: 50,',
      '      async getContextForPrompt() {',
      '        return "workspace=" + String(cfg.workspaceId) + " autoRecall=" + String(cfg.autoRecall);',
      '      },',
      '    });',
      '    api.registerPromptHook({',
      "      id: 'demo-hook',",
      '      render() {',
      "        return 'hook-context';",
      '      },',
      '    });',
      '    api.registerTool({',
      "      name: 'demo_echo',",
      "      description: 'Echo a plugin value',",
      '      parameters: {',
      "        type: 'object',",
      "        properties: { text: { type: 'string' } },",
      "        required: ['text'],",
      '      },',
      '      handler(args) {',
      '        return String(cfg.workspaceId) + ":" + String(cfg.autoRecall) + ":" + String(args.text || "");',
      '      },',
      '    });',
      '    api.registerCommand({',
      "      name: 'demo_status',",
      "      description: 'Show demo plugin status',",
      '      handler() {',
      "        return 'demo ok';",
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writePassivePlugin(rootDir: string, pluginId: string): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [`id: ${pluginId}`, `name: ${pluginId}`, 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      `  id: '${pluginId}',`,
      '  register() {},',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeMemoryProviderPlugin(rootDir: string, pluginId: string): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${pluginId}`,
      `name: ${pluginId}`,
      'kind: memory',
      'memoryProvider: true',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      `  id: '${pluginId}',`,
      "  kind: 'memory',",
      '  register(api) {',
      '    api.registerMemoryLayer({',
      `      id: '${pluginId}-layer',`,
      '      priority: 50,',
      '      getContextForPrompt() {',
      `        return '${pluginId} context';`,
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeDefinitionSchemaPlugin(rootDir: string): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'definition-schema-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: definition-schema-plugin',
      'name: Definition Schema Plugin',
      'kind: tool',
      'configSchema:',
      '  type: object',
      '  properties:',
      '    workspaceId:',
      '      type: string',
      '      default: manifest-default',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'definition-schema-plugin',",
      '  configSchema: {',
      "    type: 'object',",
      '    properties: {',
      "      workspaceId: { type: 'string', default: 'definition-default' },",
      '    },',
      '  },',
      '  register() {},',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeEnvRequirementPlugin(rootDir: string): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', 'env-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: env-plugin',
      'name: Env Plugin',
      'kind: tool',
      'requires:',
      '  env:',
      '    - TEST_PLUGIN_API_KEY',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'env-plugin',",
      '  register(api) {',
      '    api.registerCommand({',
      "      name: 'env_status',",
      "      description: 'Show required credential status',",
      '      handler() {',
      "        return api.getCredential('TEST_PLUGIN_API_KEY') || 'missing';",
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeCredentialPlugin(rootDir: string): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'credential-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: credential-plugin',
      'name: Credential Plugin',
      'kind: tool',
      'credentials:',
      '  - TEST_PLUGIN_API_KEY',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'credential-plugin',",
      '  register(api) {',
      '    api.registerCommand({',
      "      name: 'credential_status',",
      "      description: 'Show optional credential status',",
      '      handler() {',
      "        return api.getCredential('TEST_PLUGIN_API_KEY') || 'missing';",
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeMemoryWriteHookPlugin(rootDir: string): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'memory-write-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: memory-write-plugin',
      'name: Memory Write Plugin',
      'kind: tool',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'const events = [];',
      'export default {',
      "  id: 'memory-write-plugin',",
      '  register(api) {',
      "    api.on('memory_write', (context) => {",
      '      events.push(context);',
      '    });',
      '    api.registerCommand({',
      "      name: 'memory_events',",
      "      description: 'Show memory write events',",
      '      handler() {',
      '        return JSON.stringify(events);',
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeInboundWebhookPlugin(rootDir: string): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'webhook-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    ['id: webhook-plugin', 'name: Webhook Plugin', 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'webhook-plugin',",
      '  register(api) {',
      '    api.registerInboundWebhook({',
      "      name: 'email-inbound',",
      '      async handler(context) {',
      '        context.res.statusCode = 202;',
      "        context.res.setHeader('content-type', 'application/json; charset=utf-8');",
      '        context.res.end(JSON.stringify({ ok: true, path: context.path, method: context.method }));',
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function makeWebhookRequest(params: {
  method?: string;
  url: string;
  body?: string;
}): IncomingMessage {
  const chunks =
    typeof params.body === 'string' ? [Buffer.from(params.body, 'utf8')] : [];
  return Object.assign(Readable.from(chunks), {
    method: params.method || 'POST',
    url: params.url,
    headers: {},
    socket: {
      remoteAddress: '127.0.0.1',
    },
  }) as IncomingMessage;
}

function makeWebhookResponse(): ServerResponse {
  const headers: Record<string, string> = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: '',
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(chunk?: unknown) {
      if (chunk != null) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
      }
      response.writableEnded = true;
      response.headersSent = true;
    },
  };
  return response as unknown as ServerResponse;
}

function compiledPluginModulePath(rootDir: string, pluginId: string): string {
  return path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    pluginId,
    '.index.hybridclaw.mjs',
  );
}

function writeNodeRequirementPlugin(
  rootDir: string,
  options: {
    pluginId: string;
    nodeRequirement: string;
    throwOnImport?: boolean;
  },
): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    options.pluginId,
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${options.pluginId}`,
      `name: ${options.pluginId}`,
      'kind: tool',
      'requires:',
      `  node: "${options.nodeRequirement}"`,
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      ...(options.throwOnImport
        ? ["throw new Error('should not import');"]
        : []),
      'export default {',
      `  id: '${options.pluginId}',`,
      '  register(api) {',
      '    api.registerTool({',
      `      name: '${options.pluginId}_echo',`,
      `      description: 'Echo from ${options.pluginId}',`,
      '      parameters: {',
      "        type: 'object',",
      '        properties: {},',
      '        required: [],',
      '      },',
      "      handler() { return 'ok'; },",
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeThrowingImportPlugin(rootDir: string, pluginId: string): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [`id: ${pluginId}`, `name: ${pluginId}`, 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    ["throw new Error('import exploded');", ''].join('\n'),
    'utf-8',
  );
}

function writeLifecycleGetterPlugin(rootDir: string): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'lifecycle-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    ['id: lifecycle-plugin', 'name: Lifecycle Plugin', 'kind: tool', ''].join(
      '\n',
    ),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'lifecycle-plugin',",
      '  register(api) {',
      '    api.registerMemoryLayer({',
      "      id: 'getter-memory',",
      '      priority: 10,',
      '      get start() {',
      "        throw new Error('memory start getter exploded');",
      '      },',
      '    });',
      '    api.registerService({',
      "      id: 'getter-service',",
      '      get start() {',
      "        throw new Error('service start getter exploded');",
      '      },',
      '    });',
      '    api.registerTool({',
      "      name: 'lifecycle_echo',",
      "      description: 'Echo from a lifecycle test plugin',",
      '      parameters: {',
      "        type: 'object',",
      '        properties: {},',
      '        required: [],',
      '      },',
      "      handler() { return 'ok'; },",
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeJavaScriptCommandPlugin(
  rootDir: string,
  response: string,
): string {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'js-command-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    ['id: js-command-plugin', 'name: JS Command Plugin', 'kind: tool', ''].join(
      '\n',
    ),
    'utf-8',
  );
  const entrypoint = path.join(pluginDir, 'index.js');
  fs.writeFileSync(
    entrypoint,
    [
      'export default {',
      "  id: 'js-command-plugin',",
      '  register(api) {',
      '    api.registerCommand({',
      "      name: 'js_status',",
      "      description: 'Show JS plugin status',",
      '      handler() {',
      `        return ${JSON.stringify(response)};`,
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
  return entrypoint;
}

function writeJavaScriptCommandPluginWithHelper(
  rootDir: string,
  exportName: string,
  response: string,
): string {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'js-command-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    ['id: js-command-plugin', 'name: JS Command Plugin', 'kind: tool', ''].join(
      '\n',
    ),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'qmd-process.js'),
    [
      `export function ${exportName}() {`,
      `  return ${JSON.stringify(response)};`,
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  const entrypoint = path.join(pluginDir, 'index.js');
  fs.writeFileSync(
    entrypoint,
    [
      `import { ${exportName} } from './qmd-process.js';`,
      'export default {',
      "  id: 'js-command-plugin',",
      '  register(api) {',
      '    api.registerCommand({',
      "      name: 'js_status',",
      "      description: 'Show JS plugin status',",
      '      handler() {',
      `        return ${exportName}();`,
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
  return entrypoint;
}

test('loadPluginManifest trims optional strings and normalizes nested sections', async () => {
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const manifestPath = path.join(cwd, 'hybridclaw.plugin.yaml');
  fs.writeFileSync(
    manifestPath,
    [
      'id: " demo-plugin "',
      'name: " Demo Plugin "',
      'version: " 1.2.3 "',
      'description: " Example plugin "',
      'kind: tool',
      'memoryProvider: true',
      'author: " Example Author "',
      'entrypoint: " dist/index.js "',
      'requires:',
      '  bins:',
      '    - " qmd "',
      '    - name: " custom-bin "',
      '      configKey: " command "',
      '      installHint: " brew install custom-bin "',
      '      installUrl: " https://example.com/custom-bin "',
      '  env: [" API_KEY ", "", 42, " SECOND_KEY "]',
      '  node: " >=22 "',
      'install:',
      '  - kind: download',
      '    url: " https://example.com/plugin.tgz "',
      '  - kind: invalid',
      '    package: " @scope/plugin-extra "',
      'pip_dependencies:',
      '  - " mempalace>=1.0 "',
      'node_dependencies:',
      '  - package: " @scope/plugin-helper "',
      'external_dependencies:',
      '  - name: " mempalace "',
      '    check: " mempalace --version "',
      '    install: " pip install mempalace "',
      '    installUrl: " https://example.com/mempalace "',
      'configUiHints:',
      '  workspaceId:',
      '    label: " Workspace "',
      '    placeholder: " Enter workspace "',
      '    help: " Used for recall "',
      '  ignored: 123',
      '',
    ].join('\n'),
    'utf-8',
  );

  const { loadPluginManifest } = await import(
    '../src/plugins/plugin-manager.js'
  );

  expect(loadPluginManifest(manifestPath)).toEqual({
    id: 'demo-plugin',
    name: 'Demo Plugin',
    version: '1.2.3',
    description: 'Example plugin',
    kind: 'tool',
    memoryProvider: true,
    author: 'Example Author',
    entrypoint: 'dist/index.js',
    requires: {
      bins: [
        { name: 'qmd' },
        {
          name: 'custom-bin',
          configKey: 'command',
          installHint: 'brew install custom-bin',
          installUrl: 'https://example.com/custom-bin',
        },
      ],
      env: ['API_KEY', 'SECOND_KEY'],
      node: '>=22',
    },
    install: [
      {
        kind: 'download',
        package: undefined,
        url: 'https://example.com/plugin.tgz',
      },
      {
        kind: 'npm',
        package: '@scope/plugin-extra',
        url: undefined,
      },
    ],
    pipDependencies: [{ package: 'mempalace>=1.0' }],
    nodeDependencies: [{ package: '@scope/plugin-helper' }],
    externalDependencies: [
      {
        name: 'mempalace',
        check: 'mempalace --version',
        installHint: 'pip install mempalace',
        installUrl: 'https://example.com/mempalace',
      },
    ],
    configSchema: undefined,
    configUiHints: {
      workspaceId: {
        label: 'Workspace',
        placeholder: 'Enter workspace',
        help: 'Used for recall',
      },
    },
  });
});

test('loadPluginManifest rejects blank manifest ids', async () => {
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const manifestPath = path.join(cwd, 'hybridclaw.plugin.yaml');
  fs.writeFileSync(manifestPath, 'id: "   "\n', 'utf-8');

  const { loadPluginManifest } = await import(
    '../src/plugins/plugin-manager.js'
  );

  expect(() => loadPluginManifest(manifestPath)).toThrow(
    'Plugin manifest is missing `id`.',
  );
});

test('validatePluginConfig enforces common JSON Schema keywords via Ajv', async () => {
  const { validatePluginConfig } = await import(
    '../src/plugins/plugin-manager.js'
  );

  const schema = {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        minLength: 4,
        pattern: '^ws-',
      },
      recallLimit: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
      },
    },
    required: ['workspaceId', 'recallLimit'],
    additionalProperties: false,
  } as const;

  expect(() =>
    validatePluginConfig(schema, {
      workspaceId: 'ws',
      recallLimit: 2,
    }),
  ).toThrow('plugin config.workspaceId must NOT have fewer than 4 characters.');

  expect(() =>
    validatePluginConfig(schema, {
      workspaceId: 'bad-value',
      recallLimit: 2,
    }),
  ).toThrow('plugin config.workspaceId must match pattern "^ws-".');

  expect(() =>
    validatePluginConfig(schema, {
      workspaceId: 'ws-good',
      recallLimit: 9,
    }),
  ).toThrow('plugin config.recallLimit must be <= 5.');
});

test('validatePluginConfig applies defaults and strips additional properties', async () => {
  const { validatePluginConfig } = await import(
    '../src/plugins/plugin-manager.js'
  );

  expect(
    validatePluginConfig(
      {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            default: 'ws-default',
          },
          autoRecall: {
            type: 'boolean',
            default: true,
          },
        },
        additionalProperties: false,
      },
      {
        extra: 'drop-me',
      },
    ),
  ).toEqual({
    workspaceId: 'ws-default',
    autoRecall: true,
  });
});

test('resolveEffectivePluginConfigSchema prefers the plugin definition schema over the manifest copy', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDefinitionSchemaPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager, resolveEffectivePluginConfigSchema } = await import(
    '../src/plugins/plugin-manager.js'
  );
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  const [candidate] = await manager.discoverPlugins(config);
  if (!candidate) {
    throw new Error('Expected definition-schema-plugin to be discovered.');
  }

  expect(candidate.id).toBe('definition-schema-plugin');
  await expect(resolveEffectivePluginConfigSchema(candidate)).resolves.toEqual({
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        default: 'definition-default',
      },
    },
  });
});

test('plugin manager auto-discovers plugins from project directories without config entries', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'demo-plugin'))).toBe(
    false,
  );
  await expect(
    manager.executeTool({
      toolName: 'demo_echo',
      args: { text: 'hello' },
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toBe('workspace-auto:true:hello');
});

test('plugin manager allows only one external memory provider plugin', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeMemoryProviderPlugin(cwd, 'memory-provider-a');
  writeMemoryProviderPlugin(cwd, 'memory-provider-b');

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getMemoryLayers()).toEqual([
    expect.objectContaining({ id: 'memory-provider-a-layer' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'memory-provider-a',
      enabled: true,
      status: 'loaded',
    }),
    expect.objectContaining({
      id: 'memory-provider-b',
      enabled: false,
      status: 'failed',
      error:
        'Only one external memory provider can be active at a time. "memory-provider-a" is already loaded.',
    }),
  ]);
  expect(manager.listPluginSummary()).toEqual([
    {
      id: 'memory-provider-a',
      name: 'memory-provider-a',
      version: undefined,
      description: undefined,
      source: 'project',
      enabled: true,
      error: undefined,
      commands: [],
      tools: [],
      hooks: [],
    },
    {
      id: 'memory-provider-b',
      name: 'memory-provider-b',
      version: undefined,
      description: undefined,
      source: 'project',
      enabled: false,
      error:
        'Only one external memory provider can be active at a time. "memory-provider-a" is already loaded.',
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);
});

test('plugin manager prefers configured external memory providers over auto-discovered ones', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeMemoryProviderPlugin(cwd, 'memory-provider-a');
  writeMemoryProviderPlugin(cwd, 'memory-provider-b');

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'memory-provider-b',
      enabled: true,
      config: {},
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getMemoryLayers()).toEqual([
    expect.objectContaining({ id: 'memory-provider-b-layer' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'memory-provider-b',
      enabled: true,
      status: 'loaded',
    }),
    expect.objectContaining({
      id: 'memory-provider-a',
      enabled: false,
      status: 'failed',
      error:
        'Only one external memory provider can be active at a time. "memory-provider-b" is already loaded.',
    }),
  ]);
});

test('plugin manager accepts required env vars from stored runtime secrets', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeEnvRequirementPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  vi.doMock('../src/security/runtime-secrets.js', async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../src/security/runtime-secrets.js')
      >();
    return {
      ...actual,
      readStoredRuntimeSecret: vi.fn((key: string) =>
        key === 'TEST_PLUGIN_API_KEY' ? 'stored-secret' : null,
      ),
    };
  });

  try {
    vi.resetModules();
    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    const manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });

    await manager.ensureInitialized();

    expect(manager.listPluginSummary()).toEqual([
      expect.objectContaining({
        id: 'env-plugin',
        enabled: true,
        error: undefined,
        commands: ['env_status'],
      }),
    ]);

    const command = manager.findCommand('env_status');
    expect(command).toBeDefined();
    if (!command) {
      throw new Error('Expected env_status command to be registered');
    }
    await expect(
      Promise.resolve(
        command.handler([], {
          sessionId: 'session-1',
          channelId: 'tui',
        }),
      ),
    ).resolves.toBe('stored-secret');
  } finally {
    vi.doUnmock('../src/security/runtime-secrets.js');
    vi.resetModules();
  }
});

test('plugin manager exposes optional declared credentials from stored runtime secrets without gating plugin load', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeCredentialPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  vi.doMock('../src/security/runtime-secrets.js', async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../src/security/runtime-secrets.js')
      >();
    return {
      ...actual,
      readStoredRuntimeSecret: vi.fn((key: string) =>
        key === 'TEST_PLUGIN_API_KEY' ? 'stored-secret' : null,
      ),
    };
  });

  try {
    vi.resetModules();
    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    const manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });

    await manager.ensureInitialized();

    expect(manager.listPluginSummary()).toEqual([
      expect.objectContaining({
        id: 'credential-plugin',
        enabled: true,
        error: undefined,
        commands: ['credential_status'],
      }),
    ]);

    const command = manager.findCommand('credential_status');
    expect(command).toBeDefined();
    if (!command) {
      throw new Error('Expected credential_status command to be registered');
    }
    await expect(
      Promise.resolve(
        command.handler([], {
          sessionId: 'session-1',
          channelId: 'tui',
        }),
      ),
    ).resolves.toBe('stored-secret');
  } finally {
    vi.doUnmock('../src/security/runtime-secrets.js');
    vi.resetModules();
  }
});

test('plugin manager reloads JavaScript entrypoints without stale module cache', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const entrypoint = writeJavaScriptCommandPlugin(cwd, 'first');

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const firstManager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await firstManager.ensureInitialized();

  const firstCommand = firstManager.findCommand('js_status');
  expect(firstCommand).toBeDefined();
  if (!firstCommand) {
    throw new Error('Expected js_status command to be registered');
  }
  await expect(
    Promise.resolve(
      firstCommand.handler([], {
        sessionId: 'session-1',
        channelId: 'web',
      }),
    ),
  ).resolves.toBe('first');

  await firstManager.shutdown();

  writeJavaScriptCommandPlugin(cwd, 'second');
  const nextTimestamp = new Date(fs.statSync(entrypoint).mtimeMs + 2000);
  fs.utimesSync(entrypoint, nextTimestamp, nextTimestamp);

  const secondManager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await secondManager.ensureInitialized();

  const secondCommand = secondManager.findCommand('js_status');
  expect(secondCommand).toBeDefined();
  if (!secondCommand) {
    throw new Error('Expected js_status command to be registered');
  }
  await expect(
    Promise.resolve(
      secondCommand.handler([], {
        sessionId: 'session-1',
        channelId: 'web',
      }),
    ),
  ).resolves.toBe('second');

  await secondManager.shutdown();
});

test('plugin manager reloads JavaScript helper modules with the entrypoint', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const entrypoint = writeJavaScriptCommandPluginWithHelper(
    cwd,
    'buildQmdPromptContext',
    'first',
  );
  const helperPath = path.join(path.dirname(entrypoint), 'qmd-process.js');

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const firstManager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await firstManager.ensureInitialized();

  const firstCommand = firstManager.findCommand('js_status');
  expect(firstCommand).toBeDefined();
  if (!firstCommand) {
    throw new Error('Expected js_status command to be registered');
  }
  await expect(
    Promise.resolve(
      firstCommand.handler([], {
        sessionId: 'session-1',
        channelId: 'web',
      }),
    ),
  ).resolves.toBe('first');

  await firstManager.shutdown();

  writeJavaScriptCommandPluginWithHelper(
    cwd,
    'buildQmdPromptContextResult',
    'second',
  );
  const nextTimestamp = new Date(fs.statSync(entrypoint).mtimeMs + 2000);
  fs.utimesSync(entrypoint, nextTimestamp, nextTimestamp);
  fs.utimesSync(helperPath, nextTimestamp, nextTimestamp);

  const secondManager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await secondManager.ensureInitialized();

  const secondCommand = secondManager.findCommand('js_status');
  expect(secondCommand).toBeDefined();
  if (!secondCommand) {
    throw new Error('Expected js_status command to be registered');
  }
  await expect(
    Promise.resolve(
      secondCommand.handler([], {
        sessionId: 'session-1',
        channelId: 'web',
      }),
    ),
  ).resolves.toBe('second');

  await secondManager.shutdown();
});

test('plugin manager loads configured plugins, applies config defaults, and exposes tools', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: true,
      config: {
        workspaceId: 'workspace-123',
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(
    await manager.collectPromptContext({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [],
    }),
  ).toEqual(['workspace=workspace-123 autoRecall=true', 'hook-context']);
  await expect(
    manager.collectPromptContextDetails({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [],
    }),
  ).resolves.toEqual({
    replacesBuiltInMemory: false,
    sections: ['workspace=workspace-123 autoRecall=true', 'hook-context'],
    pluginIds: ['demo-plugin'],
  });
  await expect(manager.getMemoryLayerBehavior()).resolves.toEqual({
    replacesBuiltInMemory: false,
  });
  await expect(
    manager.executeTool({
      toolName: 'demo_echo',
      args: { text: 'hello' },
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toBe('workspace-123:true:hello');
  expect(manager.listPluginSummary()).toEqual([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: undefined,
      description: 'Demo plugin for testing',
      source: 'project',
      enabled: true,
      error: undefined,
      commands: ['demo_status'],
      tools: ['demo_echo'],
      hooks: ['demo-hook'],
    },
  ]);
});

test('plugin manager emits memory_write hooks for successful native memory writes', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeMemoryWriteHookPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();
  await manager.notifyMemoryWrites({
    sessionId: 'session-1',
    agentId: 'main',
    channelId: 'web',
    toolExecutions: [
      {
        name: 'memory',
        arguments:
          '{"action":"append","target":"daily","date":"2026-04-08","content":"Remember Clerk reduced auth integration time."}',
        result: 'Appended 45 chars to memory/2026-04-08.md',
        durationMs: 8,
      },
      {
        name: 'memory',
        arguments: '{"action":"search","query":"Clerk"}',
        result: 'memory/2026-04-08.md:1: Clerk',
        durationMs: 1,
      },
      {
        name: 'memory',
        arguments:
          '{"action":"write","file_path":"memory/2026-04-08.md","content":"ignored"}',
        result: 'Error: write failed',
        durationMs: 1,
        isError: true,
      },
      {
        name: 'bash',
        arguments: '{"command":"pwd"}',
        result: '/workspace',
        durationMs: 1,
      },
    ],
  });

  const command = manager.findCommand('memory_events');
  expect(command).toBeDefined();
  const rawEvents = await Promise.resolve(
    command?.handler([], {
      sessionId: 'session-1',
      channelId: 'web',
    }),
  );
  expect(JSON.parse(String(rawEvents))).toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      agentId: 'main',
      channelId: 'web',
      action: 'append',
      memoryFilePath: 'memory/2026-04-08.md',
      content: 'Remember Clerk reduced auth integration time.',
      result: 'Appended 45 chars to memory/2026-04-08.md',
    }),
  ]);
});

test('plugin manager tracks the live workspace root separately from the seeded agent workspace', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  const sessionRoot = path.join(cwd, 'projects', 'client-alpha');

  await manager.notifySessionStart({
    sessionId: 'session-workspace-root',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    workspacePath: sessionRoot,
  });

  expect(manager.getSessionWorkspaceRoot('session-workspace-root')).toBe(
    sessionRoot,
  );

  await manager.notifySessionEnd({
    sessionId: 'session-workspace-root',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    workspacePath: sessionRoot,
  });

  expect(manager.getSessionWorkspaceRoot('session-workspace-root')).toBeNull();
});

test('plugin manager honors config overrides that disable an auto-discovered plugin', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: false,
      config: {},
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getToolDefinitions()).toEqual([]);
  expect(
    await manager.collectPromptContext({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [],
    }),
  ).toEqual([]);
});

test('plugin manager disables plugins with missing required env vars before import', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'env-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: env-plugin',
      'name: Env Plugin',
      'kind: tool',
      'requires:',
      '  env: [HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST]',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      "throw new Error('should not import');",
      'export default {',
      "  id: 'env-plugin',",
      '  register() {},',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const originalEnv = process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST;
  delete process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST;

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  try {
    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    const manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });

    await expect(manager.ensureInitialized()).resolves.toBeUndefined();

    expect(manager.getToolDefinitions()).toEqual([]);
    expect(manager.getLoadedPlugins()).toEqual([
      expect.objectContaining({
        id: 'env-plugin',
        enabled: false,
        status: 'failed',
        error: 'Missing required env vars: HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST.',
        toolsRegistered: [],
        hooksRegistered: [],
      }),
    ]);
    expect(manager.listPluginSummary()).toEqual([
      {
        id: 'env-plugin',
        name: 'Env Plugin',
        version: undefined,
        description: undefined,
        source: 'project',
        enabled: false,
        error: 'Missing required env vars: HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST.',
        commands: [],
        tools: [],
        hooks: [],
      },
    ]);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST;
    } else {
      process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST = originalEnv;
    }
  }
});

test('plugin manager disables plugins with missing required binaries before import', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'bin-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: bin-plugin',
      'name: Bin Plugin',
      'kind: tool',
      'requires:',
      '  bins:',
      '    - name: qmd',
      '      configKey: command',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      "throw new Error('should not import');",
      'export default {',
      "  id: 'bin-plugin',",
      '  register() {},',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'bin-plugin',
      enabled: true,
      config: {
        command: path.join(cwd, 'missing-qmd'),
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'bin-plugin',
      enabled: false,
      status: 'failed',
      error: expect.stringContaining(
        `Missing required binaries: qmd (from command=${path.join(cwd, 'missing-qmd')}).`,
      ),
      toolsRegistered: [],
      hooksRegistered: [],
    }),
  ]);
  expect(manager.listPluginSummary()).toEqual([
    {
      id: 'bin-plugin',
      name: 'Bin Plugin',
      version: undefined,
      description: undefined,
      source: 'project',
      enabled: false,
      error: `Missing required binaries: qmd (from command=${path.join(cwd, 'missing-qmd')}).`,
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);
});

test('plugin manager rejects invalid plugin config against configSchema', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: true,
      config: {},
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();
  expect(manager.getToolDefinitions()).toEqual([]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'demo-plugin',
      enabled: true,
      status: 'failed',
      error: 'plugin config.workspaceId is required.',
      toolsRegistered: [],
      hooksRegistered: [],
    }),
  ]);
});

test('plugin manager treats bare node requirements as version pins instead of minimums', async () => {
  const currentMajor = Number.parseInt(
    process.versions.node.split('.')[0] || '0',
    10,
  );
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeNodeRequirementPlugin(cwd, {
    pluginId: 'same-major-plugin',
    nodeRequirement: String(currentMajor),
  });
  writeNodeRequirementPlugin(cwd, {
    pluginId: 'older-major-plugin',
    nodeRequirement: String(Math.max(currentMajor - 1, 0)),
    throwOnImport: true,
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'same-major-plugin_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'same-major-plugin',
      enabled: true,
      status: 'loaded',
      toolsRegistered: ['same-major-plugin_echo'],
      hooksRegistered: [],
    }),
  ]);
  expect(
    fs.existsSync(compiledPluginModulePath(cwd, 'same-major-plugin')),
  ).toBe(false);
});

test('plugin manager isolates module load failures and continues loading healthy plugins', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const brokenDir = path.join(cwd, '.hybridclaw', 'plugins', 'broken-plugin');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenDir, 'hybridclaw.plugin.yaml'),
    ['id: broken-plugin', 'name: Broken Plugin', 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(brokenDir, 'index.ts'),
    ['export default {', "  id: 'broken-plugin',", '  register(', ''].join(
      '\n',
    ),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'demo-plugin',
        enabled: true,
        status: 'loaded',
        toolsRegistered: ['demo_echo'],
        hooksRegistered: ['demo-hook'],
      }),
      expect.objectContaining({
        id: 'broken-plugin',
        enabled: true,
        status: 'failed',
        error: expect.any(String),
        toolsRegistered: [],
        hooksRegistered: [],
      }),
    ]),
  );
  expect(manager.listPluginSummary()).toEqual(
    expect.arrayContaining([
      {
        id: 'demo-plugin',
        name: 'Demo Plugin',
        version: undefined,
        description: 'Demo plugin for testing',
        source: 'project',
        enabled: true,
        error: undefined,
        commands: ['demo_status'],
        tools: ['demo_echo'],
        hooks: ['demo-hook'],
      },
      expect.objectContaining({
        id: 'broken-plugin',
        name: 'Broken Plugin',
        description: undefined,
        source: 'project',
        enabled: true,
        commands: [],
        tools: [],
        hooks: [],
        error: expect.any(String),
      }),
    ]),
  );
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'demo-plugin'))).toBe(
    false,
  );
});

test('plugin manager isolates unexpected loadPlugin crashes and continues loading healthy plugins', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });
  writePassivePlugin(cwd, 'unexpected-plugin');

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  const originalLoadPlugin = manager.loadPlugin.bind(manager);
  vi.spyOn(manager, 'loadPlugin').mockImplementation(
    async (candidate, runtimeConfig, registrationMode) => {
      if (candidate.id === 'unexpected-plugin') {
        throw new Error('unexpected load crash');
      }
      return originalLoadPlugin(candidate, runtimeConfig, registrationMode);
    },
  );

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'demo-plugin',
        enabled: true,
        status: 'loaded',
        toolsRegistered: ['demo_echo'],
        hooksRegistered: ['demo-hook'],
      }),
      expect.objectContaining({
        id: 'unexpected-plugin',
        enabled: true,
        status: 'failed',
        error: 'unexpected load crash',
        toolsRegistered: [],
        hooksRegistered: [],
      }),
    ]),
  );
});

test('plugin manager survives throwing lifecycle start getters and keeps plugin tools available', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeLifecycleGetterPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'lifecycle_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'lifecycle-plugin',
      enabled: true,
      status: 'loaded',
      toolsRegistered: ['lifecycle_echo'],
      hooksRegistered: [],
    }),
  ]);
});

test('plugin manager removes temporary compiled modules after TypeScript import failures', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });
  writeThrowingImportPlugin(cwd, 'throwing-plugin');

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'throwing-plugin',
        enabled: true,
        status: 'failed',
        error: 'import exploded',
      }),
    ]),
  );
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'demo-plugin'))).toBe(
    false,
  );
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'throwing-plugin'))).toBe(
    false,
  );
});

test('plugin manager survives unexpected gateway_start phase crashes', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  vi.spyOn(manager as any, 'dispatchHook').mockImplementation(
    async (name: string) => {
      if (name === 'gateway_start') {
        throw new Error('gateway start exploded');
      }
    },
  );

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
});

test('plugin manager resolves fixed plugin inbound webhook routes and enforces HTTP methods', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeInboundWebhookPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const { buildPluginInboundWebhookPath } = await import(
    '../src/plugins/plugin-webhooks.js'
  );
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  const webhookPath = buildPluginInboundWebhookPath(
    'webhook-plugin',
    'email-inbound',
  );
  const res = makeWebhookResponse();
  await expect(
    manager.handleInboundWebhook({
      method: 'POST',
      pathname: webhookPath,
      url: new URL(`http://localhost${webhookPath}`),
      req: makeWebhookRequest({
        method: 'POST',
        url: webhookPath,
      }),
      res,
    }),
  ).resolves.toBe(true);
  expect(res.statusCode).toBe(202);
  expect(res.body).toContain('"ok":true');

  const wrongMethodRes = makeWebhookResponse();
  await expect(
    manager.handleInboundWebhook({
      method: 'GET',
      pathname: webhookPath,
      url: new URL(`http://localhost${webhookPath}`),
      req: makeWebhookRequest({
        method: 'GET',
        url: webhookPath,
      }),
      res: wrongMethodRes,
    }),
  ).resolves.toBe(true);
  expect(wrongMethodRes.statusCode).toBe(405);

  await expect(
    manager.handleInboundWebhook({
      method: 'POST',
      pathname: '/api/plugin-webhooks/webhook-plugin/missing',
      url: new URL(
        'http://localhost/api/plugin-webhooks/webhook-plugin/missing',
      ),
      req: makeWebhookRequest({
        method: 'POST',
        url: '/api/plugin-webhooks/webhook-plugin/missing',
      }),
      res: makeWebhookResponse(),
    }),
  ).resolves.toBe(false);
});

test('plugin manager rejects unsupported inbound webhook methods', async () => {
  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager();

  expect(() =>
    manager.registerInboundWebhook('demo-plugin', {
      name: 'email-inbound',
      method: 'get' as 'GET',
      async handler() {},
    }),
  ).toThrow(
    'Plugin inbound webhook "email-inbound" on plugin "demo-plugin" has invalid method "get". Supported methods are "GET" and "POST".',
  );
});

test('plugin manager creates inbound webhook loggers from the injected logger', async () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => childLogger),
  };
  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    logger: logger as never,
  });

  manager.registerInboundWebhook('demo-plugin', {
    name: 'email-inbound',
    async handler() {},
  });

  expect(logger.child).toHaveBeenCalledWith({
    pluginId: 'demo-plugin',
    webhookName: 'email-inbound',
  });
});

test('plugin manager rolls back partial registration when register throws', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'broken-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: broken-plugin',
      'name: Broken Plugin',
      'kind: tool',
      'configSchema:',
      '  type: object',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'broken-plugin',",
      '  register(api) {',
      '    api.registerTool({',
      "      name: 'broken_echo',",
      "      description: 'Broken echo',",
      '      parameters: {',
      "        type: 'object',",
      '        properties: {},',
      '        required: [],',
      '      },',
      "      handler() { return 'broken'; },",
      '    });',
      "    throw new Error('register exploded');",
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'broken-plugin',
      enabled: true,
      status: 'failed',
      error: 'register exploded',
      toolsRegistered: ['broken_echo'],
      hooksRegistered: [],
    }),
  ]);
});

function writeOutputGuardPlugin(
  rootDir: string,
  pluginId: string,
  options: {
    priority?: number;
    behavior: 'allow' | 'rewrite' | 'block' | 'throw';
    rewriteText?: string;
    blockReason?: string;
    blockReplacement?: string;
  },
): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [`id: ${pluginId}`, `name: ${pluginId}`, 'kind: output-guard', ''].join(
      '\n',
    ),
    'utf-8',
  );
  const decisionLiteral =
    options.behavior === 'allow'
      ? "{ action: 'allow' }"
      : options.behavior === 'rewrite'
        ? `{ action: 'rewrite', text: ${JSON.stringify(options.rewriteText || 'rewritten')} }`
        : options.behavior === 'block'
          ? `{ action: 'block', reason: ${JSON.stringify(options.blockReason || 'blocked')}, replacement: ${JSON.stringify(options.blockReplacement || 'BLOCKED')} }`
          : "(() => { throw new Error('boom'); })()";
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      `  id: '${pluginId}',`,
      "  kind: 'output-guard',",
      '  register(api) {',
      '    api.registerOutputGuard({',
      `      id: '${pluginId}-guard',`,
      `      priority: ${options.priority ?? 0},`,
      '      inspect() {',
      `        return ${decisionLiteral};`,
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

test('plugin manager applies output guards in priority order and short-circuits on block', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeOutputGuardPlugin(cwd, 'guard-allow', {
    priority: 10,
    behavior: 'allow',
  });
  writeOutputGuardPlugin(cwd, 'guard-rewrite', {
    priority: 20,
    behavior: 'rewrite',
    rewriteText: 'cleaned-up output',
  });
  writeOutputGuardPlugin(cwd, 'guard-block', {
    priority: 30,
    behavior: 'block',
    blockReason: 'unsafe',
    blockReplacement: 'BLOCKED',
  });
  writeOutputGuardPlugin(cwd, 'guard-after-block', {
    priority: 40,
    behavior: 'rewrite',
    rewriteText: 'should-not-run',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  expect(manager.hasOutputGuards()).toBe(true);

  const outcome = await manager.applyOutputGuards({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    userContent: 'hi',
    resultText: 'original draft',
  });

  expect(outcome.blocked).toBe(true);
  expect(outcome.resultText).toBe('BLOCKED');
  expect(outcome.events.map((event) => event.action)).toEqual([
    'allow',
    'rewrite',
    'block',
  ]);
  expect(outcome.events[1]).toMatchObject({
    pluginId: 'guard-rewrite',
    before: 'original draft',
    after: 'cleaned-up output',
  });
  expect(outcome.events[2]).toMatchObject({
    pluginId: 'guard-block',
    before: 'cleaned-up output',
    after: 'BLOCKED',
    reason: 'unsafe',
  });
});

test('plugin manager applies registered pre-send middleware', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'pre-send-demo');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: pre-send-demo\nname: pre-send-demo\nkind: middleware\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'pre-send-demo',",
      "  kind: 'middleware',",
      '  register(api) {',
      '    api.registerMiddleware({',
      "      id: 'pre-send-demo',",
      '      pre_send(context) {',
      "        return { action: 'transform', payload: context.userContent + ' [scoped]', reason: 'scoped' };",
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyMiddleware('pre_send', {
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    messages: [{ role: 'user', content: 'hello' }],
    userContent: 'hello',
  });

  expect(outcome.blocked).toBe(false);
  expect(outcome.userContent).toBe('hello [scoped]');
  expect(outcome.events).toEqual([
    expect.objectContaining({
      skillId: 'pre-send-demo:pre-send-demo',
      action: 'transform',
      reason: 'scoped',
    }),
  ]);
});

test('plugin manager swallows errors from output guards and keeps original output', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeOutputGuardPlugin(cwd, 'guard-throws', {
    priority: 10,
    behavior: 'throw',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyOutputGuards({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    userContent: 'hi',
    resultText: 'original draft',
  });

  expect(outcome.blocked).toBe(false);
  expect(outcome.resultText).toBe('original draft');
  expect(outcome.events).toEqual([]);
});

test('plugin manager treats unknown output-guard actions as allow', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'guard-bogus');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: guard-bogus\nname: guard-bogus\nkind: output-guard\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'guard-bogus',",
      "  kind: 'output-guard',",
      '  register(api) {',
      '    api.registerOutputGuard({',
      "      id: 'guard-bogus-guard',",
      '      priority: 10,',
      '      inspect() {',
      "        return { action: 'shrug' };",
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyOutputGuards({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    userContent: 'hi',
    resultText: 'original draft',
  });

  expect(outcome.blocked).toBe(false);
  expect(outcome.resultText).toBe('original draft');
  expect(outcome.events).toEqual([
    expect.objectContaining({
      pluginId: 'guard-bogus',
      guardId: 'guard-bogus-guard',
      action: 'allow',
    }),
  ]);
});
