import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchTool } from '../../src/sandbox/tool-dispatcher.js';
import type { SandboxClient } from '../../src/sandbox/client.js';
import type { ToolCall, ToolResult, StreamChunk } from '../../src/sandbox/types.js';

/** Creates a mock SandboxClient with an in-memory filesystem. */
function createMockSandboxClient(): SandboxClient {
  const files = new Map<string, string>();
  files.set('/workspace/hello.txt', 'Hello World');
  files.set('/workspace/README.md', '# Project\nThis is a readme.');

  return {
    async readFile(_sandboxId: string, path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`404: ${path} not found`);
      return content;
    },
    async writeFile(_sandboxId: string, path: string, content: string) {
      files.set(path, content);
    },
    async deleteFile(_sandboxId: string, path: string) {
      if (!files.has(path)) throw new Error(`404: ${path} not found`);
      files.delete(path);
    },
    async runProcess(_sandboxId: string, opts: { code: string }) {
      const cmd = opts.code;
      // Simulate basic commands
      if (cmd.includes('echo')) {
        return { stdout: 'ok\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('find')) {
        return { stdout: '/workspace/hello.txt\n/workspace/README.md\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rg') || cmd.includes('grep')) {
        return { stdout: '/workspace/README.md:1:# Project\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async runProcessStream(_sandboxId: string, code: string, onChunk: (c: StreamChunk) => void) {
      if (code.includes('exit 1')) {
        onChunk({ type: 'stderr', text: 'error output' });
        onChunk({ type: 'exit', exitCode: 1 });
        return { exitCode: 1 };
      }
      onChunk({ type: 'stdout', text: 'command output\n' });
      onChunk({ type: 'exit', exitCode: 0 });
      return { exitCode: 0 };
    },
    async listDir() { return ['hello.txt', 'README.md']; },
    async createSandbox() { return { sandboxId: 'test-sb' }; },
    async deleteSandbox() {},
    async createVolume(name: string) { return { volumeId: name }; },
    async getOrCreateVolume(name: string) { return { volumeId: name }; },
  } as unknown as SandboxClient;
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}-${Date.now()}`, name, args };
}

describe('dispatchTool', () => {
  let client: SandboxClient;
  const sandboxId = 'test-sandbox';

  beforeEach(() => {
    client = createMockSandboxClient();
  });

  describe('tool allowlist', () => {
    it('blocks tools not in allowedTools list', async () => {
      const result = await dispatchTool(
        makeToolCall('bash', { command: 'ls' }),
        sandboxId, client,
        { allowedTools: ['read', 'write'] },
      );
      assert.ok(result.isError);
      assert.ok(result.content.includes('not in the allowed tools list'));
    });

    it('allows all tools when allowedTools is undefined', async () => {
      const result = await dispatchTool(
        makeToolCall('read', { path: '/workspace/hello.txt' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
    });

    it('allows tools that are in the allowedTools list', async () => {
      const result = await dispatchTool(
        makeToolCall('read', { path: '/workspace/hello.txt' }),
        sandboxId, client,
        { allowedTools: ['read', 'write'] },
      );
      assert.ok(!result.isError);
      assert.equal(result.content, 'Hello World');
    });
  });

  describe('progress callbacks', () => {
    it('calls onProgress(start) before execution', async () => {
      let startCalled = false;
      await dispatchTool(
        makeToolCall('read', { path: '/workspace/hello.txt' }),
        sandboxId, client,
        { onProgress: (phase) => { if (phase === 'start') startCalled = true; } },
      );
      assert.ok(startCalled);
    });

    it('calls onProgress(finish) with durationMs after execution', async () => {
      let finishDuration: number | undefined;
      await dispatchTool(
        makeToolCall('read', { path: '/workspace/hello.txt' }),
        sandboxId, client,
        { onProgress: (phase, _preview, durationMs) => { if (phase === 'finish') finishDuration = durationMs; } },
      );
      assert.ok(typeof finishDuration === 'number');
      assert.ok(finishDuration! >= 0);
    });
  });

  describe('read tool', () => {
    it('reads file via client.readFile and returns content', async () => {
      const result = await dispatchTool(makeToolCall('read', { path: '/workspace/hello.txt' }), sandboxId, client);
      assert.equal(result.content, 'Hello World');
      assert.ok(!result.isError);
    });

    it('returns error when path is missing', async () => {
      const result = await dispatchTool(makeToolCall('read', {}), sandboxId, client);
      assert.ok(result.isError);
      assert.ok(result.content.includes('path is required'));
    });

    it('returns error when readFile throws', async () => {
      const result = await dispatchTool(makeToolCall('read', { path: '/nonexistent' }), sandboxId, client);
      assert.ok(result.isError);
      assert.ok(result.content.includes('Error'));
    });
  });

  describe('write tool', () => {
    it('writes content via client.writeFile', async () => {
      const result = await dispatchTool(
        makeToolCall('write', { path: '/workspace/new.txt', contents: 'new content' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      // Verify it was written
      const readResult = await dispatchTool(makeToolCall('read', { path: '/workspace/new.txt' }), sandboxId, client);
      assert.equal(readResult.content, 'new content');
    });

    it('returns byte count in success message', async () => {
      const result = await dispatchTool(
        makeToolCall('write', { path: '/workspace/test.txt', contents: 'hello' }),
        sandboxId, client,
      );
      assert.ok(result.content.includes('5'));
      assert.ok(result.content.includes('Wrote'));
    });

    it('accepts both "contents" and "content" args', async () => {
      const result = await dispatchTool(
        makeToolCall('write', { path: '/workspace/test.txt', content: 'via content key' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
    });
  });

  describe('edit tool', () => {
    it('reads file, replaces old with new, writes back', async () => {
      const result = await dispatchTool(
        makeToolCall('edit', { path: '/workspace/hello.txt', old: 'World', new: 'Tests' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('Edited'));
      // Verify the change
      const readResult = await dispatchTool(makeToolCall('read', { path: '/workspace/hello.txt' }), sandboxId, client);
      assert.equal(readResult.content, 'Hello Tests');
    });

    it('returns error when old text not found', async () => {
      const result = await dispatchTool(
        makeToolCall('edit', { path: '/workspace/hello.txt', old: 'nonexistent', new: 'replaced' }),
        sandboxId, client,
      );
      assert.ok(result.isError);
      assert.ok(result.content.includes('not found'));
    });

    it('supports count parameter for multiple replacements', async () => {
      // Write a file with repeated text
      await dispatchTool(
        makeToolCall('write', { path: '/workspace/repeat.txt', contents: 'aaa' }),
        sandboxId, client,
      );
      const result = await dispatchTool(
        makeToolCall('edit', { path: '/workspace/repeat.txt', old: 'a', new: 'b', count: 2 }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('2 replacement'));
    });
  });

  describe('delete tool', () => {
    it('deletes file via client.deleteFile', async () => {
      const result = await dispatchTool(
        makeToolCall('delete', { path: '/workspace/hello.txt' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('Deleted'));
    });
  });

  describe('glob tool', () => {
    it('runs find command in sandbox and returns output', async () => {
      const result = await dispatchTool(
        makeToolCall('glob', { pattern: '*.txt' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('/workspace/'));
    });

    it('uses /workspace as default base path', async () => {
      const result = await dispatchTool(
        makeToolCall('glob', { pattern: '*.md' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
    });
  });

  describe('grep tool', () => {
    it('runs rg command in sandbox and returns output', async () => {
      const result = await dispatchTool(
        makeToolCall('grep', { pattern: 'Project' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('Project'));
    });
  });

  describe('bash tool', () => {
    it('executes command via runProcessStream', async () => {
      const result = await dispatchTool(
        makeToolCall('bash', { command: 'echo hello' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('command output'));
    });

    it('blocks dangerous commands via guardCommand', async () => {
      const result = await dispatchTool(
        makeToolCall('bash', { command: 'rm -rf /' }),
        sandboxId, client,
      );
      assert.ok(result.isError);
      assert.ok(result.content.toLowerCase().includes('blocked'));
    });

    it('returns error result for non-zero exit codes', async () => {
      const result = await dispatchTool(
        makeToolCall('bash', { command: 'exit 1' }),
        sandboxId, client,
      );
      assert.ok(result.isError);
      assert.ok(result.content.includes('Exit code 1'));
    });
  });

  describe('memory tool', () => {
    it('reads MEMORY.md by default', async () => {
      // Pre-populate MEMORY.md
      await client.writeFile(sandboxId, '/workspace/MEMORY.md', 'remembered stuff');
      const result = await dispatchTool(
        makeToolCall('memory', { action: 'read' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('remembered stuff'));
    });

    it('writes content to MEMORY.md', async () => {
      const result = await dispatchTool(
        makeToolCall('memory', { action: 'write', content: 'new memory' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      assert.ok(result.content.includes('Wrote'));
    });

    it('appends content with double newline separator', async () => {
      await client.writeFile(sandboxId, '/workspace/MEMORY.md', 'existing memory');
      const result = await dispatchTool(
        makeToolCall('memory', { action: 'append', content: 'appended memory' }),
        sandboxId, client,
      );
      assert.ok(!result.isError);
      const content = await client.readFile(sandboxId, '/workspace/MEMORY.md');
      assert.ok(content.includes('existing memory'));
      assert.ok(content.includes('appended memory'));
    });
  });

  describe('delegate tool', () => {
    it('returns __DELEGATE__ sentinel with isDelegate flag', async () => {
      const result = await dispatchTool(
        makeToolCall('delegate', { prompt: 'do something', mode: 'single' }),
        sandboxId, client,
      );
      assert.ok(result.content.startsWith('__DELEGATE__:'));
      assert.equal(result.isDelegate, true);
    });
  });

  describe('unknown tool', () => {
    it('returns error for unrecognized tool name', async () => {
      const result = await dispatchTool(
        makeToolCall('nonexistent_tool', {}),
        sandboxId, client,
      );
      assert.ok(result.isError);
      assert.ok(result.content.includes('Unknown tool'));
    });
  });
});
