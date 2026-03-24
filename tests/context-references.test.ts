import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  parseContextReferences,
  preprocessContextReferences,
  removeReferenceTokens,
  stripTrailingPunctuation,
} from '../src/context-references/index.js';
import {
  isBinaryFile,
  isSensitiveFile,
  resolveAndValidatePath,
} from '../src/context-references/security.js';

type ExecFileResult = {
  error?: Error;
  stderr?: string;
  stdout?: string;
};

type ExecFileHandler = (file: string, args: string[]) => ExecFileResult;

function createExecFileMock(handler: ExecFileHandler) {
  return vi.fn(
    (
      file: string,
      args: string[],
      options:
        | Record<string, unknown>
        | ((error: Error | null, stdout?: string, stderr?: string) => void),
      callback?: (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void,
    ) => {
      const done = typeof options === 'function' ? options : callback;
      if (!done) throw new Error('Missing execFile callback');

      const result = handler(file, args);
      if (result.error) {
        done(result.error, result.stdout || '', result.stderr || '');
        return;
      }

      done(null, result.stdout || '', result.stderr || '');
    },
  );
}

async function loadResolverModule(execFileHandler?: ExecFileHandler) {
  vi.resetModules();
  if (execFileHandler) {
    vi.doMock('node:child_process', () => ({
      execFile: createExecFileMock(execFileHandler),
    }));
  } else {
    vi.doUnmock('node:child_process');
  }

  return import('../src/context-references/resolver.js');
}

describe('context references', () => {
  let workspacePath = '';

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), 'hybridclaw-context-references-'),
    );

    await mkdir(path.join(workspacePath, 'src'), { recursive: true });
    await mkdir(path.join(workspacePath, 'folder', 'nested'), {
      recursive: true,
    });

    await writeFile(
      path.join(workspacePath, 'src', 'app.ts'),
      [
        "export const label = 'hybridclaw';",
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        'export const enabled = true;',
      ].join('\n'),
    );
    await writeFile(path.join(workspacePath, 'folder', 'a.txt'), 'alpha\n');
    await writeFile(
      path.join(workspacePath, 'folder', 'nested', 'b.ts'),
      'export const value = 1;\n',
    );
    await writeFile(path.join(workspacePath, '.env'), 'SECRET=test-key\n');
    await writeFile(
      path.join(workspacePath, 'binary.bin'),
      Buffer.from([1, 2]),
    );
    await writeFile(
      path.join(workspacePath, 'mystery'),
      Buffer.from([97, 0, 98]),
    );
    await writeFile(path.join(workspacePath, 'notes.txt'), 'plain text file\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock('node:child_process');
    if (workspacePath) {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  describe('parser', () => {
    test('parses file references with paths', () => {
      const refs = parseContextReferences('Review @file:src/app.ts please');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({
        kind: 'file',
        path: 'src/app.ts',
        raw: '@file:src/app.ts',
      });
    });

    test('parses file line ranges', () => {
      const refs = parseContextReferences('Check @file:src/app.ts:2-4');
      expect(refs[0]).toMatchObject({
        kind: 'file',
        path: 'src/app.ts',
        lineStart: 2,
        lineEnd: 4,
      });
    });

    test('normalizes reversed file line ranges', () => {
      const refs = parseContextReferences('Check @file:src/app.ts:9-3');
      expect(refs[0]).toMatchObject({
        lineStart: 3,
        lineEnd: 9,
      });
    });

    test('parses simple diff and staged references', () => {
      const refs = parseContextReferences('Inspect @diff and @staged');
      expect(refs.map((ref) => ref.kind)).toEqual(['diff', 'staged']);
    });

    test('parses git commit counts', () => {
      const refs = parseContextReferences('Inspect @git:7');
      expect(refs[0]).toMatchObject({
        kind: 'git',
        commitCount: 7,
      });
    });

    test('parses URLs and strips trailing punctuation', () => {
      const refs = parseContextReferences(
        'Read @url:https://example.com/docs.md?x=1).',
      );
      expect(refs[0]).toMatchObject({
        kind: 'url',
        url: 'https://example.com/docs.md?x=1',
        raw: '@url:https://example.com/docs.md?x=1',
      });
    });

    test('ignores email addresses and plain handles', () => {
      const refs = parseContextReferences(
        'email user@example.com or ping @someone about it',
      );
      expect(refs).toHaveLength(0);
    });

    test('parses multiple references in one message', () => {
      const refs = parseContextReferences(
        'Use @file:src/app.ts with @folder:folder and @diff',
      );
      expect(refs).toHaveLength(3);
    });

    test('returns no references for empty input', () => {
      expect(parseContextReferences('')).toEqual([]);
    });

    test('stripTrailingPunctuation removes trailing punctuation and brackets', () => {
      expect(stripTrailingPunctuation('src/app.ts),')).toBe('src/app.ts');
      expect(stripTrailingPunctuation('https://example.com/docs]')).toBe(
        'https://example.com/docs',
      );
    });

    test('removeReferenceTokens collapses whitespace around stripped tokens', () => {
      const message = 'Review (@diff), then @file:src/app.ts please.';
      const refs = parseContextReferences(message);
      expect(removeReferenceTokens(message, refs)).toBe(
        'Review(), then please.',
      );
    });

    test('removeReferenceTokens preserves messages without references', () => {
      expect(removeReferenceTokens('plain text', [])).toBe('plain text');
    });
  });

  describe('security', () => {
    test('resolves paths inside the allowed root', () => {
      expect(
        resolveAndValidatePath(workspacePath, 'src/app.ts', workspacePath),
      ).toBe(path.join(workspacePath, 'src', 'app.ts'));
    });

    test('blocks traversal outside the allowed root', () => {
      expect(() =>
        resolveAndValidatePath(workspacePath, '../outside.txt', workspacePath),
      ).toThrow('Path escapes allowed root');
    });

    test('marks dotenv files as sensitive', () => {
      expect(isSensitiveFile(path.join(workspacePath, '.env'))).toBe(true);
    });

    test('marks aws and ssh paths as sensitive', () => {
      expect(isSensitiveFile(path.join(workspacePath, '.ssh', 'id_rsa'))).toBe(
        true,
      );
      expect(
        isSensitiveFile(path.join(workspacePath, '.aws', 'credentials')),
      ).toBe(true);
    });

    test('detects binary files from known binary extensions', async () => {
      await expect(
        isBinaryFile(path.join(workspacePath, 'binary.bin')),
      ).resolves.toBe(true);
    });

    test('detects binary files from null bytes', async () => {
      await expect(
        isBinaryFile(path.join(workspacePath, 'mystery')),
      ).resolves.toBe(true);
    });

    test('treats plain text files as text', async () => {
      await expect(
        isBinaryFile(path.join(workspacePath, 'notes.txt')),
      ).resolves.toBe(false);
    });
  });

  describe('resolver', () => {
    test('expands file references with a language fence', async () => {
      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences('Inspect @file:src/app.ts')[0];
      const [warning, block] = await expandReference(ref, workspacePath, {
        allowedRoot: workspacePath,
      });
      expect(warning).toBeNull();
      expect(block).toContain('File: src/app.ts');
      expect(block).toContain('```ts');
      expect(block).toContain("export const label = 'hybridclaw';");
    });

    test('expands file line ranges only', async () => {
      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences('Inspect @file:src/app.ts:2-3')[0];
      const [, block] = await expandReference(ref, workspacePath, {
        allowedRoot: workspacePath,
      });
      expect(block).toContain('File: src/app.ts:2-3');
      expect(block).toContain('export function add');
      expect(block).toContain('return a + b;');
      expect(block).not.toContain("export const label = 'hybridclaw';");
    });

    test('warns when a file reference is missing', async () => {
      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences('Inspect @file:src/missing.ts')[0];
      const [warning, block] = await expandReference(ref, workspacePath, {
        allowedRoot: workspacePath,
      });
      expect(warning).toContain('file not found');
      expect(block).toBeNull();
    });

    test('lists folder entries and falls back when ripgrep is unavailable', async () => {
      const { expandReference } = await loadResolverModule((file) => {
        if (file === 'rg') {
          return { error: new Error('rg unavailable') };
        }
        return { stdout: '' };
      });
      const ref = parseContextReferences('Inspect @folder:folder')[0];
      const [warning, block] = await expandReference(ref, workspacePath, {
        allowedRoot: workspacePath,
      });
      expect(warning).toBeNull();
      expect(block).toContain('Folder: folder');
      expect(block).toContain('a.txt');
      expect(block).toContain('nested/b.ts');
    });

    test('returns git diff output', async () => {
      const gitDiff = 'diff --git a/src/app.ts b/src/app.ts\n+const value = 1;';
      const { expandReference } = await loadResolverModule((file, args) => {
        if (file === 'git' && args[0] === 'diff') {
          return { stdout: gitDiff };
        }
        return { stdout: '' };
      });
      const ref = parseContextReferences('Inspect @diff')[0];
      const [warning, block] = await expandReference(ref, workspacePath, {});
      expect(warning).toBeNull();
      expect(block).toContain('Git Diff');
      expect(block).toContain(gitDiff);
    });

    test('clamps git commit counts between one and ten', async () => {
      const { expandReference } = await loadResolverModule((file, args) => {
        if (file === 'git') {
          expect(args).toContain('-10');
          return { stdout: 'commit abc123\n+change' };
        }
        return { stdout: '' };
      });
      const ref = parseContextReferences('Inspect @git:25')[0];
      const [warning, block] = await expandReference(ref, workspacePath, {});
      expect(warning).toBeNull();
      expect(block).toContain('Git Log (10 commits)');
    });

    test('warns for invalid git commit counts', async () => {
      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences('Inspect @git:not-a-number')[0];
      const [warning, block] = await expandReference(ref, workspacePath, {});
      expect(warning).toContain('expected @git:<count>');
      expect(block).toBeNull();
    });

    test('expands URLs through the injected fetcher', async () => {
      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences(
        'Read @url:https://example.com/docs.md',
      )[0];
      const [warning, block] = await expandReference(ref, workspacePath, {
        urlFetcher: async () => '# hello\n',
      });
      expect(warning).toBeNull();
      expect(block).toContain('URL: https://example.com/docs.md');
      expect(block).toContain('```md');
      expect(block).toContain('# hello');
    });

    test('blocks redirect responses in the default URL fetcher', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 302,
        type: 'basic',
        headers: new Headers(),
        text: async () => '',
      }));
      vi.stubGlobal('fetch', fetchMock);

      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences(
        'Read @url:https://example.com/docs.md',
      )[0];
      const [warning, block] = await expandReference(ref, workspacePath, {});

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/docs.md',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(warning).toContain('redirects are blocked');
      expect(block).toBeNull();
    });

    test('times out slow URL fetches in the default fetcher', async () => {
      const fetchMock = vi.fn(async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      });
      vi.stubGlobal('fetch', fetchMock);

      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences(
        'Read @url:https://example.com/docs.md',
      )[0];
      const [warning, block] = await expandReference(ref, workspacePath, {});

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/docs.md',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(warning).toContain('timed out after 10000ms');
      expect(block).toBeNull();
    });

    test('blocks oversized URL responses in the default fetcher', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('x'.repeat(600_000), {
            headers: {
              'content-type': 'text/plain; charset=utf-8',
            },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const { expandReference } = await loadResolverModule();
      const ref = parseContextReferences(
        'Read @url:https://example.com/docs.txt',
      )[0];
      const [warning, block] = await expandReference(ref, workspacePath, {});

      expect(warning).toContain('response body exceeds 524288 bytes');
      expect(block).toBeNull();
    });
  });

  describe('preprocessContextReferences', () => {
    test('passes messages through when there are no references', async () => {
      const result = await preprocessContextReferences({
        message: 'plain text request',
        cwd: workspacePath,
        allowedRoot: workspacePath,
      });
      expect(result).toMatchObject({
        originalMessage: 'plain text request',
        strippedMessage: 'plain text request',
        message: 'plain text request',
        attachedContext: null,
      });
    });

    test('expands file references into attached context and strips tokens from the message', async () => {
      const result = await preprocessContextReferences({
        message: 'Review @file:src/app.ts carefully',
        cwd: workspacePath,
        allowedRoot: workspacePath,
      });
      expect(result.originalMessage).toBe('Review @file:src/app.ts carefully');
      expect(result.strippedMessage).toBe('Review carefully');
      expect(result.message).toContain('Review carefully');
      expect(result.message).toContain('--- Attached Context ---');
      expect(result.message).toContain('File: src/app.ts');
    });

    test('adds a soft-limit warning but keeps attached context', async () => {
      await writeFile(
        path.join(workspacePath, 'src', 'large.ts'),
        `export const payload = '${'x'.repeat(300)}';\n`,
      );
      const result = await preprocessContextReferences({
        message: 'Review @file:src/large.ts',
        cwd: workspacePath,
        allowedRoot: workspacePath,
        contextLength: 200,
      });
      expect(result.attachedContext).not.toBeNull();
      expect(result.warnings.join('\n')).toContain('soft limit');
      expect(result.message).toContain('--- Context Warnings ---');
      expect(result.message).toContain('--- Attached Context ---');
    });

    test('drops attached context when the hard limit is exceeded', async () => {
      await writeFile(
        path.join(workspacePath, 'src', 'huge.ts'),
        `export const payload = '${'x'.repeat(900)}';\n`,
      );
      const result = await preprocessContextReferences({
        message: 'Review @file:src/huge.ts',
        cwd: workspacePath,
        allowedRoot: workspacePath,
        contextLength: 200,
      });
      expect(result.attachedContext).toBeNull();
      expect(result.warnings.join('\n')).toContain('hard limit');
      expect(result.message).toContain('--- Context Warnings ---');
      expect(result.message).not.toContain('--- Attached Context ---');
    });

    test('keeps successful blocks when other references fail', async () => {
      const result = await preprocessContextReferences({
        message: 'Review @file:src/app.ts and @file:src/missing.ts',
        cwd: workspacePath,
        allowedRoot: workspacePath,
      });
      expect(result.strippedMessage).toBe('Review and');
      expect(result.attachedContext).toContain('File: src/app.ts');
      expect(result.warnings.join('\n')).toContain('file not found');
    });
  });
});
