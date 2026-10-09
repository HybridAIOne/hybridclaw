import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container show_widget tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  test('writes the widget under widgets/ and returns it with the widget media type', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-widget-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    const { executeToolWithMetadata, TOOL_DEFINITIONS } = await import(
      '../container/src/tools.js'
    );
    const html = '<input type="range"><script>hy.ask("Mehr")</script>';

    const result = await executeToolWithMetadata(
      'show_widget',
      JSON.stringify({ title: 'Sparrechner für Ölheizung', html }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      path: string;
      artifacts: Array<{ path: string; filename: string; mimeType: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toMatch(
      /^widgets\/sparrechner-fur-olheizung-[0-9a-f]{8}\.html$/,
    );
    expect(parsed.artifacts).toEqual([
      {
        path: parsed.path,
        filename: 'Sparrechner für Ölheizung.html',
        mimeType: 'application/vnd.hybridai.widget+html',
      },
    ]);
    expect(fs.readFileSync(path.join(workspaceRoot, parsed.path), 'utf-8')).toBe(
      html,
    );
    expect(TOOL_DEFINITIONS.map((tool) => tool.function.name)).toContain(
      'show_widget',
    );
  });

  test('a changed widget gets its own file, so earlier replies keep theirs', async () => {
    const { widgetFilePath } = await import('../container/src/tools/widget.js');
    expect(widgetFilePath('Quiz', '<p>1</p>')).not.toBe(
      widgetFilePath('Quiz', '<p>2</p>'),
    );
    expect(widgetFilePath('!!!', '<p>1</p>')).toMatch(/^widgets\/widget-/);
  });

  test('refuses a widget without title or HTML', async () => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-widget-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    const { executeToolWithMetadata } = await import(
      '../container/src/tools.js'
    );

    const noHtml = await executeToolWithMetadata(
      'show_widget',
      JSON.stringify({ title: 'Quiz' }),
    );
    const noTitle = await executeToolWithMetadata(
      'show_widget',
      JSON.stringify({ html: '<p>1</p>' }),
    );

    expect(noHtml.isError).toBe(true);
    expect(noHtml.output).toContain('`html` is required');
    expect(noTitle.isError).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, 'widgets'))).toBe(false);
  });
});
