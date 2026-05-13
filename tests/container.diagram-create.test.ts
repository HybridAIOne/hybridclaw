import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;

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
      expect(fs.existsSync(hostPath(parsed.source_artifact_ref))).toBe(true);
      expect(fs.existsSync(hostPath(parsed.rendered_artifact_ref))).toBe(true);
    }
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
});
