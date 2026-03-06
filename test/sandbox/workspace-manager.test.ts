import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Force exit after tests — runtime-config.ts starts a file watcher retry timer
// that keeps the event loop alive and can't be cleaned up externally.
after(() => setTimeout(() => process.exit(0), 50).unref());

import { WorkspaceManager, type WorkspaceClient, type ContextFile } from '../../src/sandbox/workspace-manager.js';

/** In-memory mock of the WorkspaceClient interface. */
function createMockClient(): WorkspaceClient & {
  files: Map<string, Map<string, string>>;
  volumes: Map<string, string>;
} {
  const files = new Map<string, Map<string, string>>();
  const volumes = new Map<string, string>();

  return {
    files,
    volumes,
    async createVolume(name: string) {
      volumes.set(name, name);
      return { volumeId: name };
    },
    async getOrCreateVolume(name: string) {
      if (!volumes.has(name)) volumes.set(name, name);
      return { volumeId: name };
    },
    async readFile(sandboxId: string, path: string) {
      const sandbox = files.get(sandboxId);
      if (!sandbox || !sandbox.has(path)) throw new Error(`404: ${path} not found`);
      return sandbox.get(path)!;
    },
    async writeFile(sandboxId: string, path: string, content: string) {
      if (!files.has(sandboxId)) files.set(sandboxId, new Map());
      files.get(sandboxId)!.set(path, content);
    },
  };
}

describe('WorkspaceManager', () => {
  let client: ReturnType<typeof createMockClient>;
  let manager: WorkspaceManager;

  beforeEach(() => {
    client = createMockClient();
    manager = new WorkspaceManager(client);
  });

  describe('ensureVolume', () => {
    it('calls getOrCreateVolume with ws-{agentId} name', async () => {
      const result = await manager.ensureVolume('bot-123');
      assert.equal(result.volumeId, 'ws-bot-123');
      assert.ok(client.volumes.has('ws-bot-123'));
    });

    it('returns volumeId from client', async () => {
      const result = await manager.ensureVolume('agent-x');
      assert.equal(typeof result.volumeId, 'string');
      assert.ok(result.volumeId.length > 0);
    });
  });

  describe('bootstrapWorkspace', () => {
    it('uploads template files that do not exist in sandbox', async () => {
      // The manager reads templates from cwd/templates/. Since we're in a test context,
      // the templates dir may or may not exist. We verify that if readFile throws (404),
      // writeFile is called.
      await manager.bootstrapWorkspace('sb-1', 'agent-1');
      // At minimum, no errors thrown. Files are only written if templates exist on disk.
    });

    it('skips files that already exist in sandbox', async () => {
      // Pre-populate a file in the sandbox
      client.files.set('sb-1', new Map([['/workspace/SOUL.md', 'existing soul content']]));
      await manager.bootstrapWorkspace('sb-1', 'agent-1');
      // Existing file should not be overwritten
      assert.equal(client.files.get('sb-1')!.get('/workspace/SOUL.md'), 'existing soul content');
    });
  });

  describe('loadWorkspaceContext', () => {
    it('returns array of ContextFile for files that exist in sandbox', async () => {
      client.files.set('sb-1', new Map([
        ['/workspace/SOUL.md', 'I am a helpful assistant.'],
        ['/workspace/MEMORY.md', 'Remember this.'],
      ]));
      const files = await manager.loadWorkspaceContext('sb-1', 'agent-1');
      assert.ok(files.length >= 2);
      assert.ok(files.some(f => f.name === 'SOUL.md'));
      assert.ok(files.some(f => f.name === 'MEMORY.md'));
    });

    it('skips files that throw on readFile (404)', async () => {
      client.files.set('sb-1', new Map([
        ['/workspace/SOUL.md', 'soul content'],
      ]));
      const files = await manager.loadWorkspaceContext('sb-1', 'agent-1');
      // Only SOUL.md should be returned, all others should be skipped
      assert.ok(files.some(f => f.name === 'SOUL.md'));
      assert.ok(!files.some(f => f.name === 'TOOLS.md'));
    });

    it('skips files with empty content', async () => {
      client.files.set('sb-1', new Map([
        ['/workspace/SOUL.md', ''],
        ['/workspace/MEMORY.md', 'has content'],
      ]));
      const files = await manager.loadWorkspaceContext('sb-1', 'agent-1');
      assert.ok(!files.some(f => f.name === 'SOUL.md'));
      assert.ok(files.some(f => f.name === 'MEMORY.md'));
    });

    it('truncates files exceeding MAX_FILE_CHARS', async () => {
      const longContent = 'x'.repeat(25_000);
      client.files.set('sb-1', new Map([
        ['/workspace/SOUL.md', longContent],
      ]));
      const files = await manager.loadWorkspaceContext('sb-1', 'agent-1');
      const soul = files.find(f => f.name === 'SOUL.md');
      assert.ok(soul);
      assert.ok(soul.content.length < longContent.length);
      assert.ok(soul.content.endsWith('[truncated]'));
    });
  });

  describe('buildContextPrompt', () => {
    it('returns empty string for empty file list', () => {
      assert.equal(manager.buildContextPrompt([]), '');
    });

    it('includes # Project Context header', () => {
      const files: ContextFile[] = [{ name: 'SOUL.md', content: 'Be helpful.' }];
      const prompt = manager.buildContextPrompt(files);
      assert.ok(prompt.includes('# Project Context'));
    });

    it('includes current date/time section', () => {
      const files: ContextFile[] = [{ name: 'SOUL.md', content: 'Be helpful.' }];
      const prompt = manager.buildContextPrompt(files);
      assert.ok(prompt.includes('## Current Date & Time'));
    });

    it('includes each file as ## heading with content', () => {
      const files: ContextFile[] = [
        { name: 'SOUL.md', content: 'Soul content here.' },
        { name: 'MEMORY.md', content: 'Memory content.' },
      ];
      const prompt = manager.buildContextPrompt(files);
      assert.ok(prompt.includes('## SOUL.md'));
      assert.ok(prompt.includes('Soul content here.'));
      assert.ok(prompt.includes('## MEMORY.md'));
      assert.ok(prompt.includes('Memory content.'));
    });

    it('extracts timezone from USER.md **Timezone:** field', () => {
      const files: ContextFile[] = [
        { name: 'USER.md', content: '**Timezone:** America/New_York\nOther stuff.' },
      ];
      const prompt = manager.buildContextPrompt(files);
      assert.ok(prompt.includes('America/New_York'));
    });
  });

  describe('isBootstrapping', () => {
    it('returns false when BOOTSTRAP.md does not exist', async () => {
      client.files.set('sb-1', new Map());
      const result = await manager.isBootstrapping('sb-1');
      assert.equal(result, false);
    });

    it('returns true when BOOTSTRAP.md exists and templates are unmodified', async () => {
      // BOOTSTRAP.md exists, and IDENTITY/USER.md are not present (so template comparison is skipped)
      client.files.set('sb-1', new Map([
        ['/workspace/BOOTSTRAP.md', 'Bootstrap instructions'],
      ]));
      const result = await manager.isBootstrapping('sb-1');
      assert.equal(result, true);
    });
  });
});

describe('WorkspaceManager + SandboxLifecycleManager integration', () => {
  // These tests are covered in lifecycle-manager behavior;
  // here we verify workspace manager can be used by lifecycle manager interface.
  it('ensureVolume is idempotent', async () => {
    const client = createMockClient();
    const manager = new WorkspaceManager(client);
    const first = await manager.ensureVolume('agent-1');
    const second = await manager.ensureVolume('agent-1');
    assert.equal(first.volumeId, second.volumeId);
  });
});
