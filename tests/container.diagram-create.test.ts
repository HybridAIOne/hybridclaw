import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
const ORIGINAL_PLANTUML_SERVER_URL = process.env.HYBRIDCLAW_PLANTUML_SERVER_URL;
const ORIGINAL_LEGACY_PLANTUML_SERVER_URL = process.env.PLANTUML_SERVER_URL;
const ORIGINAL_PATH = process.env.PATH;

let workspaceRoot = '';

async function loadTools() {
  vi.resetModules();
  return import('../container/src/tools.js');
}

async function loadDiagramModule() {
  vi.resetModules();
  return import('../container/src/diagram-create.js');
}

function hostPath(displayPath: string): string {
  return path.join(workspaceRoot, displayPath.replace(/^\/workspace\/?/, ''));
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-diagram-create-'),
  );
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_WORKSPACE_ROOT == null) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = ORIGINAL_WORKSPACE_ROOT;
  }
  if (ORIGINAL_WORKSPACE_DISPLAY_ROOT == null) {
    delete process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
  } else {
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT =
      ORIGINAL_WORKSPACE_DISPLAY_ROOT;
  }
  if (ORIGINAL_PLANTUML_SERVER_URL == null) {
    delete process.env.HYBRIDCLAW_PLANTUML_SERVER_URL;
  } else {
    process.env.HYBRIDCLAW_PLANTUML_SERVER_URL = ORIGINAL_PLANTUML_SERVER_URL;
  }
  if (ORIGINAL_LEGACY_PLANTUML_SERVER_URL == null) {
    delete process.env.PLANTUML_SERVER_URL;
  } else {
    process.env.PLANTUML_SERVER_URL = ORIGINAL_LEGACY_PLANTUML_SERVER_URL;
  }
  if (ORIGINAL_PATH == null) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
  vi.unstubAllGlobals();
  vi.resetModules();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('diagram tools', () => {
  test('creates validated SVG artifacts for every Mermaid diagram type', async () => {
    const { executeToolWithMetadata } = await loadTools();
    const types = [
      'sequence',
      'flowchart',
      'state',
      'er',
      'class',
      'gantt',
      'git-graph',
      'mindmap',
      'pie',
    ];

    for (const type of types) {
      const result = await executeToolWithMetadata(
        'diagram_create',
        JSON.stringify({
          description: `${type} diagram for a gateway request`,
          type,
          format: 'mermaid',
          render_to: 'svg',
        }),
      );
      const parsed = JSON.parse(result.output) as {
        success: boolean;
        valid: boolean;
        rendered_artifact_ref: string;
        source_artifact_ref: string;
        type: string;
        format: string;
      };

      expect(result.isError).toBe(false);
      expect(parsed.success).toBe(true);
      expect(parsed.valid).toBe(true);
      expect(parsed.type).toBe(type);
      expect(parsed.format).toBe('mermaid');
      expect(parsed.source_artifact_ref).toContain(
        '/workspace/.generated-diagrams/skills/diagram/',
      );
      expect(fs.existsSync(hostPath(parsed.source_artifact_ref))).toBe(true);
      expect(fs.existsSync(hostPath(parsed.rendered_artifact_ref))).toBe(true);
    }
  });

  test('diagram tool names are schema-visible', async () => {
    const { executeToolWithMetadata, TOOL_DEFINITIONS } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'request pipeline',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      type: string;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.type).toBe('flowchart');
    const advertisedToolNames = TOOL_DEFINITIONS.map(
      (tool) => tool.function.name,
    );
    expect(advertisedToolNames).toEqual(
      expect.arrayContaining([
        'diagram_create',
        'diagram_update',
        'diagram_validate',
      ]),
    );
  });

  test('auto classification reaches the roadmap fixture threshold', async () => {
    const { classifyDiagramType } = await loadDiagramModule();
    const fixtures: Array<[string, string]> = [
      ['sequence diagram of user login request and response', 'sequence'],
      ['API call flow between gateway worker and database', 'sequence'],
      ['process pipeline with decisions and retries', 'flowchart'],
      ['deployment flow through build test and ship', 'flowchart'],
      ['lifecycle states for a ticket', 'state'],
      ['status machine from queued to running to failed', 'state'],
      ['database schema with users orders and line items', 'er'],
      ['entity relationship diagram for invoices', 'er'],
      ['class inheritance for provider interfaces', 'class'],
      ['UML class diagram for adapters and factory', 'class'],
      ['release roadmap with milestones and dates', 'gantt'],
      ['project schedule for implementation review launch', 'gantt'],
      ['git branches commits and merge back to main', 'git-graph'],
      ['release train with branch commit and merge', 'git-graph'],
      ['mindmap of skill capabilities', 'mindmap'],
      ['taxonomy and concept map for documents', 'mindmap'],
      ['pie chart of cost share by provider', 'pie'],
      ['percentage breakdown of request types', 'pie'],
      ['topology of services across regions', 'flowchart'],
      ['user talks to bot then bot calls tools', 'sequence'],
    ];
    const correct = fixtures.filter(
      ([description, expected]) =>
        classifyDiagramType(description) === expected,
    ).length;

    expect(correct / fixtures.length).toBeGreaterThanOrEqual(0.8);
  });

  test('validate returns syntax errors without rendering', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_validate',
      JSON.stringify({
        source: 'flowchart TD\n  A[Start',
        type: 'flowchart',
        format: 'mermaid',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      valid: boolean;
      errors: string[];
      suggested_fix?: string;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.join('\n')).toContain('unbalanced');
    expect(parsed.suggested_fix).toContain('flowchart TD');
  });

  test('accepts CRLF fenced source and escaped quotes during validation', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_validate',
      JSON.stringify({
        source:
          '```mermaid\r\nflowchart TD\r\n  A["He said \\"ready\\""] --> B[Done]\r\n```',
        type: 'flowchart',
        format: 'mermaid',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      valid: boolean;
      errors: string[];
    };

    expect(result.isError).toBe(false);
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  test('sanitizes Mermaid-sensitive label characters in generated skeletons', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'deploy [canary] {region|us}',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      valid: boolean;
      source: string;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.source).toContain('A[deploy canary regionus]');
  });

  test('creates non-Mermaid source artifacts through all adapters', async () => {
    const { executeToolWithMetadata } = await loadTools();
    const cases = [
      ['plantuml', 'sequence'],
      ['graphviz', 'flowchart'],
      ['excalidraw', 'flowchart'],
    ];

    for (const [format, type] of cases) {
      const result = await executeToolWithMetadata(
        'diagram_create',
        JSON.stringify({
          description: 'gateway service talks to worker and store',
          type,
          format,
          render_to: 'none',
        }),
      );
      const parsed = JSON.parse(result.output) as {
        success: boolean;
        valid: boolean;
        source_artifact_ref: string;
        rendered_artifact_ref: string | null;
        format: string;
      };

      expect(result.isError).toBe(false);
      expect(parsed.success).toBe(true);
      expect(parsed.valid).toBe(true);
      expect(parsed.format).toBe(format);
      expect(parsed.rendered_artifact_ref).toBeNull();
      expect(fs.existsSync(hostPath(parsed.source_artifact_ref))).toBe(true);
    }
  });

  test('PlantUML server rendering has a timeout', async () => {
    vi.useFakeTimers();
    process.env.HYBRIDCLAW_PLANTUML_SERVER_URL = 'https://plantuml.test';
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { executeToolWithMetadata } = await loadTools();

    const resultPromise = executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'sequence diagram for timeout',
        type: 'sequence',
        format: 'plantuml',
        render_to: 'svg',
      }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'PlantUML server request timed out after 15000ms',
    );
  });

  test('renders PlantUML SVG through the configured server', async () => {
    process.env.HYBRIDCLAW_PLANTUML_SERVER_URL = 'https://plantuml.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<svg><text>plantuml</text></svg>')),
    );
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'sequence diagram for native PlantUML render',
        type: 'sequence',
        format: 'plantuml',
        render_to: 'svg',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      rendered_artifact_ref: string;
      runtime_events: Array<{ type: string }>;
      warnings: string[];
    };

    expect(result.isError).toBe(false);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.runtime_events).toContainEqual(
      expect.objectContaining({ type: 'diagram.rendered' }),
    );
    expect(
      fs.readFileSync(hostPath(parsed.rendered_artifact_ref), 'utf-8'),
    ).toContain('plantuml');
  });

  test('renders Graphviz SVG through dot when available', async () => {
    const binDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-dot-bin-'),
    );
    const dotPath = path.join(binDir, 'dot');
    fs.writeFileSync(
      dotPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const out = process.argv[process.argv.indexOf('-o') + 1];",
        "fs.writeFileSync(out, '<svg><text>graphviz</text></svg>');",
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(dotPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH || ''}`;
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'graphviz topology',
        type: 'flowchart',
        format: 'graphviz',
        render_to: 'svg',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      rendered_artifact_ref: string;
      warnings: string[];
    };

    expect(result.isError).toBe(false);
    expect(parsed.warnings).toEqual([]);
    expect(
      fs.readFileSync(hostPath(parsed.rendered_artifact_ref), 'utf-8'),
    ).toContain('graphviz');
  });

  test('renders Excalidraw JSON to SVG without a source fallback', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'editable launch sketch',
        type: 'flowchart',
        format: 'excalidraw',
        render_to: 'svg',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      rendered_artifact_ref: string;
      warnings: string[];
    };

    expect(result.isError).toBe(false);
    expect(parsed.warnings).toEqual([]);
    const svg = fs.readFileSync(
      hostPath(parsed.rendered_artifact_ref),
      'utf-8',
    );
    expect(svg).toContain('<svg');
    expect(svg).toContain('editable launch sketch');
    expect(svg).not.toContain('Excalidraw JSON source');
  });

  test('updates an existing diagram artifact while preserving type and format', async () => {
    const { executeToolWithMetadata } = await loadTools();
    const create = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        description: 'simple request pipeline',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const created = JSON.parse(create.output) as {
      source_artifact_ref: string;
    };

    const update = await executeToolWithMetadata(
      'diagram_update',
      JSON.stringify({
        artifact_ref: created.source_artifact_ref,
        instructions: 'add retry queue',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const updated = JSON.parse(update.output) as {
      success: boolean;
      valid: boolean;
      source: string;
      type: string;
      format: string;
    };

    expect(update.isError).toBe(false);
    expect(updated.success).toBe(true);
    expect(updated.valid).toBe(true);
    expect(updated.type).toBe('flowchart');
    expect(updated.format).toBe('mermaid');
    expect(updated.source).toContain('Update: add retry queue');
  });

  test('sequence update annotations do not invent participants', async () => {
    const { executeToolWithMetadata } = await loadTools();
    const create = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        source:
          'sequenceDiagram\n  participant Client\n  participant API\n  Client->>API: Request',
        type: 'sequence',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const created = JSON.parse(create.output) as {
      source_artifact_ref: string;
    };

    const update = await executeToolWithMetadata(
      'diagram_update',
      JSON.stringify({
        artifact_ref: created.source_artifact_ref,
        instructions: 'add retry note',
        type: 'sequence',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const updated = JSON.parse(update.output) as {
      success: boolean;
      valid: boolean;
      source: string;
    };

    expect(update.isError).toBe(false);
    expect(updated.success).toBe(true);
    expect(updated.valid).toBe(true);
    expect(updated.source).toContain('%% Update: add retry note');
    expect(updated.source).not.toContain('Note over User,System');
  });

  test('invalid Excalidraw update artifacts return structured validation failures', async () => {
    const sourcePath = path.join(workspaceRoot, 'bad.excalidraw.json');
    fs.writeFileSync(sourcePath, '{not json', 'utf-8');
    const { executeToolWithMetadata } = await loadTools();

    const update = await executeToolWithMetadata(
      'diagram_update',
      JSON.stringify({
        artifact_ref: '/workspace/bad.excalidraw.json',
        instructions: 'add label',
        format: 'excalidraw',
        render_to: 'none',
      }),
    );
    const parsed = JSON.parse(update.output) as {
      success: boolean;
      valid: boolean;
      errors: string[];
    };

    expect(update.isError).toBe(false);
    expect(parsed.success).toBe(false);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.join('\n')).toContain('not valid JSON');
  });

  test('missing artifact_ref fails instead of generating a skeleton', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_update',
      JSON.stringify({
        artifact_ref: '/workspace/missing.mmd',
        instructions: 'add retry path',
        format: 'mermaid',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'artifact_ref not found or unreadable: /workspace/missing.mmd',
    );
  });

  test('failed validation marks persisted source artifacts as invalid', async () => {
    const { executeToolWithMetadata } = await loadTools();

    const result = await executeToolWithMetadata(
      'diagram_create',
      JSON.stringify({
        source: 'flowchart TD\n  A[Start',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      valid: boolean;
      source_artifact_valid: boolean;
      warnings: string[];
      runtime_events: Array<{ type: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(false);
    expect(parsed.valid).toBe(false);
    expect(parsed.source_artifact_valid).toBe(false);
    expect(parsed.runtime_events).toContainEqual(
      expect.objectContaining({ type: 'diagram.validation_failed' }),
    );
    expect(parsed.warnings).toContain(
      'Source artifact was saved for debugging but did not validate.',
    );
  });

  test('runtime fix-up loop repairs before rendering and caps attempts at two', async () => {
    const { runDiagramTool } = await loadDiagramModule();
    let attempts = 0;

    const result = await runDiagramTool(
      'create',
      {
        source: 'flowchart TD\n  A[Start',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      },
      {
        fixSource: async () => {
          attempts += 1;
          return attempts === 1
            ? 'flowchart TD\n  A[Start'
            : 'flowchart TD\n  A[Start] --> B[Done]';
        },
      },
    );
    const parsed = JSON.parse(result) as {
      success: boolean;
      valid: boolean;
      fixup_attempts: number;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.fixup_attempts).toBe(2);

    const capped = await runDiagramTool(
      'create',
      {
        source: 'flowchart TD\n  A[Start',
        type: 'flowchart',
        format: 'mermaid',
        render_to: 'none',
      },
      {
        fixSource: async () => {
          return 'flowchart TD\n  A[Start';
        },
      },
    );
    const cappedParsed = JSON.parse(capped) as {
      success: boolean;
      fixup_attempts: number;
    };

    expect(cappedParsed.success).toBe(false);
    expect(cappedParsed.fixup_attempts).toBe(2);
  });

  test('diagram tool schemas allow source-only create and update calls', async () => {
    const { TOOL_DEFINITIONS } = await loadTools();
    const requiredByName = new Map(
      TOOL_DEFINITIONS.map((tool) => [
        tool.function.name,
        tool.function.parameters.required,
      ]),
    );

    expect(requiredByName.get('diagram_create')).toEqual([]);
    expect(requiredByName.get('diagram_update')).toEqual([]);
  });

  test('advertised tool names are OpenAI-compatible function names', async () => {
    const { TOOL_DEFINITIONS } = await loadTools();

    expect(
      TOOL_DEFINITIONS.map((tool) => tool.function.name).filter(
        (name) => !/^[A-Za-z0-9_-]+$/.test(name),
      ),
    ).toEqual([]);
  });
});
