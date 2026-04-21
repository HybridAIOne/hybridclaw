import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installGbrainPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'gbrain');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'gbrain');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeGbrainStub(
  rootDir: string,
  options?: {
    callPayloadByToolAndQuery?: Record<string, unknown>;
    callPayloads?: Record<string, unknown>;
    doctorPayload?: Record<string, unknown>;
    passthroughText?: string;
    queryResults?: unknown[];
    toolsJsonDelayMs?: number;
    toolsJsonRaw?: string;
    toolsJson?: Array<{
      description: string;
      name: string;
      parameters: Record<string, string>;
    }>;
  },
): string {
  const scriptPath = path.join(rootDir, 'mock-gbrain.mjs');
  const toolsJson = options?.toolsJson || [
    {
      name: 'query',
      description: 'Hybrid search with vector + keyword + expansion',
      parameters: {
        query: 'string',
        limit: 'number?',
        expand: 'boolean?',
      },
    },
    {
      name: 'search',
      description: 'Keyword search using full-text search',
      parameters: {
        query: 'string',
        limit: 'number?',
      },
    },
    {
      name: 'get_page',
      description: 'Read a page by slug',
      parameters: {
        slug: 'string',
        fuzzy: 'boolean?',
      },
    },
    {
      name: 'put_raw_data',
      description: 'Store raw API response data for a page',
      parameters: {
        slug: 'string',
        source: 'string',
        data: 'object',
      },
    },
    {
      name: 'log_ingest',
      description: 'Log an ingestion event',
      parameters: {
        source_type: 'string',
        source_ref: 'string',
        pages_updated: 'array',
        summary: 'string',
      },
    },
    {
      name: 'get_stats',
      description: 'Brain statistics',
      parameters: {},
    },
  ];
  const queryResults = options?.queryResults || [
    {
      slug: 'companies/acme',
      title: 'Acme',
      type: 'company',
      chunk_text:
        'Acme changed pricing on Tuesday and is now pushing enterprise expansion.',
      chunk_source: 'timeline',
      score: 0.93,
      stale: false,
    },
    {
      slug: 'people/jordan',
      title: 'Jordan',
      type: 'person',
      chunk_text:
        'Jordan mentioned Acme board prep and enterprise pipeline risk.',
      chunk_source: 'compiled_truth',
      score: 0.87,
      stale: false,
    },
  ];
  const callPayloadByToolAndQuery = options?.callPayloadByToolAndQuery || {};
  const callPayloads = options?.callPayloads || {
    get_page: {
      slug: 'companies/acme',
      title: 'Acme',
      type: 'company',
      compiled_truth: 'Acme is an enterprise software company.',
      timeline: '2026-03-18 Acme changed pricing.',
      tags: ['enterprise'],
    },
    get_stats: {
      page_count: 42,
      chunk_count: 211,
      embedded_count: 199,
    },
  };
  const doctorPayload = options?.doctorPayload || {
    status: 'healthy',
    checks: [
      {
        name: 'connection',
        status: 'ok',
        message: 'Connected, 42 pages',
      },
      {
        name: 'pgvector',
        status: 'ok',
        message: 'Extension installed',
      },
    ],
  };
  const passthroughText =
    options?.passthroughText || 'gbrain sync completed successfully';

  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2)',
      'const writeStdout = async (value) => {',
      '  const text = typeof value === "string" ? value : JSON.stringify(value)',
      '  await new Promise((resolve, reject) => {',
      `    process.stdout.write(\`\${text}\\n\`, (error) => {`,
      '      if (error) reject(error)',
      '      else resolve()',
      '    })',
      '  })',
      '}',
      'if (args[0] === "--tools-json") {',
      `  const toolsJsonDelayMs = ${JSON.stringify(options?.toolsJsonDelayMs || 0)}`,
      `  const toolsJsonRaw = ${JSON.stringify(options?.toolsJsonRaw || '')}`,
      '  if (toolsJsonDelayMs > 0) {',
      '    await new Promise((resolve) => setTimeout(resolve, toolsJsonDelayMs))',
      '  }',
      '  if (toolsJsonRaw) {',
      '    await writeStdout(toolsJsonRaw)',
      '    process.exit(0)',
      '  }',
      `  await writeStdout(${JSON.stringify(toolsJson)})`,
      '  process.exit(0)',
      '}',
      'if (args[0] === "doctor" && args.includes("--json")) {',
      `  await writeStdout(${JSON.stringify(doctorPayload)})`,
      '  process.exit(0)',
      '}',
      'if (args[0] === "call") {',
      '  const operationName = String(args[1] || "")',
      '  const payload = args[2] ? JSON.parse(args[2]) : {}',
      `  const byToolAndQuery = ${JSON.stringify(callPayloadByToolAndQuery)}`,
      `  const callPayloads = ${JSON.stringify(callPayloads)}`,
      `  const defaultQueryResults = ${JSON.stringify(queryResults)}`,
      `  const queryKey = \`\${operationName}:\${String(payload.query || "")}\``,
      '  let response = null',
      '  if (Object.prototype.hasOwnProperty.call(byToolAndQuery, queryKey)) {',
      '    response = byToolAndQuery[queryKey]',
      '  } else if (operationName === "query" || operationName === "search") {',
      '    response = defaultQueryResults',
      '  } else if (Object.prototype.hasOwnProperty.call(callPayloads, operationName)) {',
      '    response = callPayloads[operationName]',
      '  } else {',
      '    response = { operation: operationName, payload }',
      '  }',
      '  await writeStdout(response)',
      '  process.exit(0)',
      '}',
      'if (args[0] === "echo-env") {',
      '  await writeStdout({',
      '    anthropic: process.env.ANTHROPIC_API_KEY || null,',
      '    database: process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || null,',
      '    openai: process.env.OPENAI_API_KEY || null,',
      '    secret: process.env.HYBRIDCLAW_GBRAIN_SECRET_TEST || null,',
      '  })',
      '  process.exit(0)',
      '}',
      `await writeStdout(${JSON.stringify(passthroughText)})`,
      'process.exit(0)',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllGlobals: true,
});

test('resolveGbrainPluginConfig normalizes defaults and runtime-relative paths', async () => {
  const runtime = {
    cwd: '/tmp/project',
    homeDir: '/Users/example',
  };

  const { resolveGbrainPluginConfig } = await import(
    '../plugins/gbrain/src/config.js'
  );

  expect(
    resolveGbrainPluginConfig(
      {
        command: 'custom-gbrain',
        maxInjectedChars: 5000,
        maxResults: 8,
        maxSnippetChars: 600,
        searchMode: 'SEARCH',
        timeoutMs: 9000,
        workingDirectory: '~/brain',
      },
      runtime,
    ),
  ).toEqual({
    command: 'custom-gbrain',
    maxInjectedChars: 5000,
    maxResults: 8,
    maxSnippetChars: 600,
    searchMode: 'search',
    timeoutMs: 9000,
    workingDirectory: '/Users/example/brain',
  });
});

test('gbrain plugin injects prompt context, registers prefixed tools, and exposes a status command', async () => {
  const homeDir = makeTempDir('hybridclaw-gbrain-home-');
  const cwd = makeTempDir('hybridclaw-gbrain-project-');
  installGbrainPlugin(cwd);
  const gbrainCommand = writeGbrainStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'gbrain',
      enabled: true,
      config: {
        command: gbrainCommand,
        maxInjectedChars: 800,
        maxResults: 2,
        maxSnippetChars: 120,
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

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'What changed with Acme since Tuesday?',
        created_at: '2026-04-10T09:00:00.000Z',
      },
    ],
  });

  const retrievalContext = promptContext.find((section) =>
    section.includes('External gbrain knowledge results:'),
  );
  const guideContext = promptContext.find((section) =>
    section.includes('GBrain plugin guide:'),
  );

  expect(promptContext).toHaveLength(2);
  expect(retrievalContext).toBeDefined();
  expect(guideContext).toBeDefined();
  expect(retrievalContext).toContain('GBrain retrieval mode: query');
  expect(retrievalContext).toContain('companies/acme');
  expect(retrievalContext).toContain(
    'Acme changed pricing on Tuesday and is now pushing enterprise expansion.',
  );

  const toolDefinitions = manager.getToolDefinitions();
  expect(toolDefinitions.map((tool) => tool.name)).toEqual([
    'gbrain_get_page',
    'gbrain_get_stats',
    'gbrain_log_ingest',
    'gbrain_put_raw_data',
    'gbrain_query',
    'gbrain_search',
  ]);
  const putRawDataTool = toolDefinitions.find(
    (tool) => tool.name === 'gbrain_put_raw_data',
  );
  const logIngestTool = toolDefinitions.find(
    (tool) => tool.name === 'gbrain_log_ingest',
  );
  expect(putRawDataTool).toEqual(
    expect.objectContaining({
      name: 'gbrain_put_raw_data',
      parameters: {
        type: 'object',
        properties: expect.objectContaining({
          data: {
            type: 'object',
          },
        }),
        required: ['slug', 'source', 'data'],
      },
    }),
  );
  expect(logIngestTool).toEqual(
    expect.objectContaining({
      name: 'gbrain_log_ingest',
      parameters: {
        type: 'object',
        properties: expect.objectContaining({
          pages_updated: {
            type: 'array',
            items: { type: 'string' },
          },
        }),
        required: ['source_type', 'source_ref', 'pages_updated', 'summary'],
      },
    }),
  );

  const queryToolResult = await manager.executeTool({
    toolName: 'gbrain_query',
    args: {
      query: 'acme board prep',
    },
    sessionId: 'session-1',
    channelId: 'web',
  });
  expect(JSON.parse(queryToolResult)).toEqual([
    expect.objectContaining({
      slug: 'companies/acme',
    }),
    expect.objectContaining({
      slug: 'people/jordan',
    }),
  ]);

  const command = manager.findCommand('gbrain');
  expect(command).toBeDefined();
  await expect(
    command?.handler([], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Doctor: healthy');
  await expect(
    command?.handler([], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Stats: pages 42 chunks 211 embedded 199');
  await expect(
    command?.handler(['sync'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('gbrain sync completed successfully');
});

test('gbrain plugin falls back to a condensed keyword search when the primary query misses', async () => {
  const homeDir = makeTempDir('hybridclaw-gbrain-home-');
  const cwd = makeTempDir('hybridclaw-gbrain-project-');
  installGbrainPlugin(cwd);
  const gbrainCommand = writeGbrainStub(cwd, {
    callPayloadByToolAndQuery: {
      'query:According to docs/content/extensibility/plugins.md, how are plugins discovered?':
        [],
      'search:content extensibility plugins discovered': [
        {
          slug: 'docs/content/extensibility/plugins',
          title: 'Plugin System',
          type: 'doc',
          chunk_text:
            'HybridClaw plugins are local runtime extensions discovered from plugin directories.',
          chunk_source: 'compiled_truth',
          score: 0.89,
          stale: false,
        },
      ],
    },
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'gbrain',
      enabled: true,
      config: {
        command: gbrainCommand,
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

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-keywords',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-keywords',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content:
          'According to docs/content/extensibility/plugins.md, how are plugins discovered?',
        created_at: '2026-04-10T09:00:00.000Z',
      },
    ],
  });

  const retrievalContext = promptContext.find((section) =>
    section.includes('External gbrain knowledge results:'),
  );

  expect(promptContext).toHaveLength(2);
  expect(retrievalContext).toBeDefined();
  expect(retrievalContext).toContain('GBrain retrieval mode: search');
  expect(retrievalContext).toContain(
    'GBrain search query: content extensibility plugins discovered',
  );
  expect(retrievalContext).toContain('Plugin System');
  expect(retrievalContext).toContain(
    'HybridClaw plugins are local runtime extensions discovered from plugin directories.',
  );
});

test('runGbrain forwards declared gbrain credentials and strips unrelated secrets', async () => {
  const cwd = makeTempDir('hybridclaw-gbrain-project-');
  const gbrainCommand = writeGbrainStub(cwd);
  const previousSecret = process.env.HYBRIDCLAW_GBRAIN_SECRET_TEST;
  process.env.HYBRIDCLAW_GBRAIN_SECRET_TEST = 'super-secret';

  try {
    const { runGbrain } = await import(
      '../plugins/gbrain/src/gbrain-process.js'
    );
    const result = await runGbrain(['echo-env'], {
      command: gbrainCommand,
      credentialEnv: {
        ANTHROPIC_API_KEY: 'ant-secret',
        GBRAIN_DATABASE_URL: 'postgres://brain',
        OPENAI_API_KEY: 'openai-secret',
      },
      maxInjectedChars: 500,
      timeoutMs: 1000,
      workingDirectory: cwd,
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({
      anthropic: 'ant-secret',
      database: 'postgres://brain',
      openai: 'openai-secret',
      secret: null,
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.HYBRIDCLAW_GBRAIN_SECRET_TEST;
    } else {
      process.env.HYBRIDCLAW_GBRAIN_SECRET_TEST = previousSecret;
    }
  }
});

test('discoverGbrainToolsSync times out when --tools-json hangs', async () => {
  const cwd = makeTempDir('hybridclaw-gbrain-project-');
  const gbrainCommand = writeGbrainStub(cwd, {
    toolsJsonDelayMs: 200,
  });
  const { discoverGbrainToolsSync } = await import(
    '../plugins/gbrain/src/gbrain-process.js'
  );

  expect(() =>
    discoverGbrainToolsSync({
      command: gbrainCommand,
      maxInjectedChars: 500,
      timeoutMs: 10,
      workingDirectory: cwd,
    }),
  ).toThrow('GBrain tool discovery timed out after 10ms.');
});

test('discoverGbrainToolsSync surfaces malformed discovery JSON with previews', async () => {
  const cwd = makeTempDir('hybridclaw-gbrain-project-');
  const gbrainCommand = writeGbrainStub(cwd, {
    toolsJsonRaw: '{"bad"',
  });
  const { discoverGbrainToolsSync } = await import(
    '../plugins/gbrain/src/gbrain-process.js'
  );

  expect(() =>
    discoverGbrainToolsSync({
      command: gbrainCommand,
      maxInjectedChars: 500,
      timeoutMs: 1000,
      workingDirectory: cwd,
    }),
  ).toThrow(
    /Failed to parse GBrain tool discovery JSON:.*stdout preview: \{"bad".*stderr preview: \(empty\)\./,
  );
});
