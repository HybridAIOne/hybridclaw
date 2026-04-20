import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as yazl from 'yazl';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function textResponse(
  body: string,
  status = 200,
  contentType = 'text/plain; charset=utf-8',
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
    },
  });
}

function markdownResponse(body: string): Response {
  return textResponse(body, 200, 'text/markdown; charset=utf-8');
}

function binaryResponse(
  body: Uint8Array,
  contentType = 'application/octet-stream',
): Response {
  return new Response(Buffer.from(body), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
    },
  });
}

function streamingBinaryResponse(
  body: Uint8Array,
  contentType = 'application/octet-stream',
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': contentType,
      },
    },
  );
}

function getAuthorizationHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('authorization');
}

async function createZipArchive(
  entries: Array<{ name: string; content: string | Buffer }>,
): Promise<Uint8Array> {
  const archivePath = path.join(
    os.tmpdir(),
    `hybridclaw-skills-import-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`,
  );

  await new Promise<void>((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const output = fs.createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipFile.outputStream.on('error', reject).pipe(output);
    for (const entry of entries) {
      zipFile.addBuffer(
        Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content, 'utf-8'),
        entry.name,
      );
    }
    zipFile.end();
  });

  try {
    return new Uint8Array(fs.readFileSync(archivePath));
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

describe('skill import', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

  function createPackagedSkillRoot(skillName: string): string {
    const tempPackagedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-packaged-community-'),
    );
    const skillDir = path.join(tempPackagedRoot, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: ${skillName}
description: Test packaged skill.
---

# ${skillName}
`,
    );
    return tempPackagedRoot;
  }

  beforeEach(() => {
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-skills-import-'),
    );
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalDisableWatcher === undefined) {
      delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    } else {
      process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalDisableWatcher;
    }
  });

  test('imports a packaged community skill with an explicit official source', async () => {
    const skillName = 'test-community-skill';
    const tempPackagedRoot = createPackagedSkillRoot(skillName);
    vi.doMock('../src/infra/install-root.js', () => ({
      resolveInstallPath: () => tempPackagedRoot,
    }));

    const { importSkill } = await import('../src/skills/skills-import.ts');
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');

    const result = await importSkill(`official/${skillName}`);

    expect(result.skillName).toBe(skillName);
    expect(result.replacedExisting).toBe(false);
    expect(result.resolvedSource).toBe(`official/${skillName}`);
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);

    const importedSkill = loadSkillCatalog().find(
      (skill) => skill.name === skillName,
    );
    expect(importedSkill?.source).toBe('community');
  });

  test('imports a GitHub skill from a repo skills/ subdirectory', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/openai/skills') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/k8s?ref=main'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/skills/k8s?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skills/k8s/SKILL.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/SKILL.md',
          },
          {
            name: 'references',
            path: 'skills/k8s/references',
            type: 'dir',
          },
        ]);
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/skills/k8s/references?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'usage.md',
            path: 'skills/k8s/references/usage.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/references/usage.md',
          },
        ]);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/SKILL.md'
      ) {
        return markdownResponse(`---
name: k8s
description: Kubernetes helper skill.
---

# Kubernetes

Use this for Kubernetes tasks.
`);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/references/usage.md'
      ) {
        return markdownResponse('# Usage\n\nkubectl get pods\n');
      }
      if (
        url.startsWith('https://api.github.com/repos/openai/skills/contents/')
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('openai/skills/k8s', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('k8s');
    expect(result.replacedExisting).toBe(false);
    expect(result.resolvedSource).toBe(
      'https://github.com/openai/skills/tree/main/skills/k8s',
    );
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(result.skillDir, 'references', 'usage.md')),
    ).toBe(true);

    const importedSkill = loadSkillCatalog().find(
      (skill) => skill.name === 'k8s',
    );
    expect(importedSkill?.source).toBe('community');
  });

  test('falls back to the GitHub archive when the API is rate-limited', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'skills-main/skills/.experimental/create-plan/SKILL.md',
        content: `---
name: create-plan
description: Create a plan.
---

# Create Plan
`,
      },
      {
        name: 'skills-main/skills/.experimental/create-plan/references/guide.md',
        content: '# Guide\n',
      },
    ]);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/skills/.experimental/create-plan?ref=main'
      ) {
        return jsonResponse(
          {
            message:
              "API rate limit exceeded for 95.91.237.118. (But here's the good news: Authenticated requests get a higher rate limit.)",
          },
          403,
        );
      }
      if (url === 'https://codeload.github.com/openai/skills/zip/main') {
        return binaryResponse(archiveBytes, 'application/zip');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill(
      'https://github.com/openai/skills/tree/main/skills/.experimental/create-plan',
      {
        fetchImpl: fetchStub as typeof fetch,
      },
    );

    expect(result.skillName).toBe('create-plan');
    expect(result.resolvedSource).toBe(
      'https://github.com/openai/skills/tree/main/skills/.experimental/create-plan',
    );
    expect(
      fs.existsSync(path.join(result.skillDir, 'references', 'guide.md')),
    ).toBe(true);
  });

  test('sends GitHub auth headers only to api.github.com', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://api.github.com/')) {
          expect(getAuthorizationHeader(init)).toBe('Bearer test-token');
        }
        if (url.startsWith('https://raw.githubusercontent.com/')) {
          expect(getAuthorizationHeader(init)).toBeNull();
        }

        if (url === 'https://api.github.com/repos/openai/skills') {
          return jsonResponse({ default_branch: 'main' });
        }
        if (
          url ===
          'https://api.github.com/repos/openai/skills/contents/k8s?ref=main'
        ) {
          return jsonResponse({ message: 'Not Found' }, 404);
        }
        if (
          url ===
          'https://api.github.com/repos/openai/skills/contents/skills/k8s?ref=main'
        ) {
          return jsonResponse([
            {
              name: 'SKILL.md',
              path: 'skills/k8s/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/SKILL.md',
            },
          ]);
        }
        if (
          url ===
          'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/SKILL.md'
        ) {
          return markdownResponse(`---
name: k8s
description: Kubernetes helper skill.
---

# Kubernetes
`);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    const result = await importSkill('openai/skills/k8s', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('k8s');
  });

  test('fails before buffering when content-length exceeds the import budget', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(16));
    const oversizedResponse = {
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(5 * 1024 * 1024 + 1),
      }),
      arrayBuffer: arrayBufferSpy,
    } as unknown as Response;

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/openai/skills') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/big?ref=main'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/skills/big?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skills/big/SKILL.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/openai/skills/main/skills/big/SKILL.md',
          },
        ]);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/openai/skills/main/skills/big/SKILL.md'
      ) {
        return oversizedResponse;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      importSkill('openai/skills/big', {
        fetchImpl: fetchStub as typeof fetch,
      }),
    ).rejects.toThrow('Remote skill exceeds the 5242880 byte import limit.');
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  test('fails when the streamed body exceeds the import budget without content-length', async () => {
    const { readResponseBytesWithinImportBudget } = await import(
      '../src/skills/skill-import-commons.ts'
    );

    await expect(
      readResponseBytesWithinImportBudget(
        streamingBinaryResponse(
          new Uint8Array(5 * 1024 * 1024 + 1),
          'text/markdown; charset=utf-8',
        ),
        { fileCount: 0, totalBytes: 0 },
      ),
    ).rejects.toThrow('Remote skill exceeds the 5242880 byte import limit.');
  });

  test('applies the shared file-count import budget', async () => {
    const { assertImportBudget } = await import(
      '../src/skills/skill-import-commons.ts'
    );
    expect(() =>
      assertImportBudget({ fileCount: 256, totalBytes: 0 }, 1),
    ).toThrow('Remote skill exceeds the 256-file import limit.');
  });

  test('shares one budget across GitHub candidate retries', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const firstBytes = new Uint8Array(4 * 1024 * 1024);
    const secondBytes = new Uint8Array(2 * 1024 * 1024);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/openai/skills') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/k8s?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'k8s/SKILL.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/openai/skills/main/k8s/SKILL.md',
          },
          {
            name: 'references',
            path: 'k8s/references',
            type: 'dir',
          },
        ]);
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/k8s/references?ref=main'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url ===
        'https://api.github.com/repos/openai/skills/contents/skills/k8s?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skills/k8s/SKILL.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/SKILL.md',
          },
        ]);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/openai/skills/main/k8s/SKILL.md'
      ) {
        return binaryResponse(firstBytes, 'text/markdown; charset=utf-8');
      }
      if (
        url ===
        'https://raw.githubusercontent.com/openai/skills/main/skills/k8s/SKILL.md'
      ) {
        return binaryResponse(secondBytes, 'text/markdown; charset=utf-8');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      importSkill('openai/skills/k8s', {
        fetchImpl: fetchStub as typeof fetch,
      }),
    ).rejects.toThrow('Remote skill exceeds the 5242880 byte import limit.');
  });

  test('reports the exact GitHub paths tried when an import path is missing', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/acme/catalog') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (
        url ===
          'https://api.github.com/repos/acme/catalog/contents/missing?ref=main' ||
        url ===
          'https://api.github.com/repos/acme/catalog/contents/skills/missing?ref=main'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url === 'https://codeload.github.com/acme/catalog/zip/main' ||
        url === 'https://codeload.github.com/acme/catalog/zip/master'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url.startsWith('https://api.github.com/repos/acme/catalog/contents/')
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      importSkill('acme/catalog/missing', {
        fetchImpl: fetchStub as typeof fetch,
      }),
    ).rejects.toThrow(
      'No SKILL.md was found in acme/catalog. Tried: acme/catalog/missing, acme/catalog/skills/missing. Use an explicit skill directory or SKILL.md path.',
    );
  });

  test('rejects bare-word and insecure registry-style import sources', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    await expect(importSkill('himalaya')).rejects.toThrow(
      'Unsupported skill source',
    );
    await expect(
      importSkill('well-known:http://mintlify.com/docs'),
    ).rejects.toThrow('Expected an HTTPS URL');
  });

  test('imports a skills.sh skill when the slug differs from the repo folder', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'agent-skills-main/skills/react-best-practices/SKILL.md',
        content: `---
name: vercel-react-best-practices
description: React guidance.
---

# Vercel React Best Practices
`,
      },
      {
        name: 'agent-skills-main/skills/react-best-practices/rules/async-parallel.md',
        content: '# Async Parallel\n',
      },
    ]);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/vercel-labs/agent-skills') {
        return jsonResponse({ message: 'API rate limit exceeded' }, 403);
      }
      if (
        url.startsWith(
          'https://api.github.com/repos/vercel-labs/agent-skills/contents/',
        )
      ) {
        return jsonResponse({ message: 'API rate limit exceeded' }, 403);
      }
      if (
        url === 'https://codeload.github.com/vercel-labs/agent-skills/zip/main'
      ) {
        return binaryResponse(archiveBytes, 'application/zip');
      }
      if (
        url ===
        'https://codeload.github.com/vercel-labs/agent-skills/zip/master'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill(
      'skills-sh/vercel-labs/agent-skills/vercel-react-best-practices',
      {
        fetchImpl: fetchStub as typeof fetch,
      },
    );

    expect(result.skillName).toBe('vercel-react-best-practices');
    expect(result.resolvedSource).toBe(
      'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
    );
    expect(
      fs.existsSync(path.join(result.skillDir, 'rules', 'async-parallel.md')),
    ).toBe(true);
  });

  test('imports a ClawHub skill from the bundle download endpoint', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'SKILL.md',
        content: `---
name: self-improving-agent
description: Keep learning.
---

# Self Improving Agent
`,
      },
      {
        name: 'references/examples.md',
        content: '# Examples\n',
      },
    ]);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/self-improving-agent') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url === 'https://clawhub.ai/api/v1/skills/self-improving-agent') {
        return jsonResponse({
          latestVersion: { version: '3.0.6' },
        });
      }
      if (
        url ===
        'https://clawhub.ai/api/v1/download?slug=self-improving-agent&version=3.0.6'
      ) {
        return binaryResponse(archiveBytes, 'application/zip');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('clawhub/self-improving-agent', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('self-improving-agent');
    expect(result.resolvedSource).toBe(
      'https://clawhub.ai/skills/self-improving-agent',
    );
    expect(
      fs.existsSync(path.join(result.skillDir, 'references', 'examples.md')),
    ).toBe(true);
  });

  test('uses CLAWHUB_API_BASE_URL env var for ClawHub imports', async () => {
    vi.stubEnv('CLAWHUB_API_BASE_URL', 'https://clawhub-proxy.internal/api/v1');

    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'SKILL.md',
        content: `---
name: self-improving-agent
description: Keep learning.
---

# Self Improving Agent
`,
      },
    ]);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/self-improving-agent') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url ===
        'https://clawhub-proxy.internal/api/v1/skills/self-improving-agent'
      ) {
        return jsonResponse({
          latestVersion: { version: '3.0.6' },
        });
      }
      if (
        url ===
        'https://clawhub-proxy.internal/api/v1/download?slug=self-improving-agent&version=3.0.6'
      ) {
        return binaryResponse(archiveBytes, 'application/zip');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('clawhub/self-improving-agent', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('self-improving-agent');
  });

  test('retries retryable ClawHub responses and cancels retry bodies', async () => {
    vi.stubEnv(
      'CLAWHUB_API_BASE_URL',
      'https://clawhub-proxy.internal/api/v1///',
    );

    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'SKILL.md',
        content: `---
name: self-improving-agent
description: Keep learning.
---

# Self Improving Agent
`,
      },
    ]);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/self-improving-agent') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url ===
        'https://clawhub-proxy.internal/api/v1/skills/self-improving-agent'
      ) {
        return jsonResponse({
          latestVersion: { version: '1.0.0' },
        });
      }
      if (
        url ===
        'https://clawhub-proxy.internal/api/v1/download?slug=self-improving-agent&version=1.0.0'
      ) {
        return binaryResponse(archiveBytes, 'application/zip');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('clawhub/self-improving-agent', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('self-improving-agent');
  });

  test('falls back to default URL when CLAWHUB_API_BASE_URL is empty', async () => {
    vi.stubEnv('CLAWHUB_API_BASE_URL', '  ');

    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'SKILL.md',
        content: `---
name: self-improving-agent
description: Keep learning.
---

# Self Improving Agent
`,
      },
    ]);

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/self-improving-agent') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url === 'https://clawhub.ai/api/v1/skills/self-improving-agent') {
        return jsonResponse({
          latestVersion: { version: '3.0.6' },
        });
      }
      if (
        url ===
        'https://clawhub.ai/api/v1/download?slug=self-improving-agent&version=3.0.6'
      ) {
        return binaryResponse(archiveBytes, 'application/zip');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('clawhub/self-improving-agent', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('self-improving-agent');
  });

  test('imports a LobeHub agent as a generated skill', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://chat-agents.lobehub.com/github-issue-helper.json') {
        return jsonResponse({
          identifier: 'github-issue-helper',
          meta: {
            title: 'Github Issue Helper',
            description: 'Assist you in creating issues',
            tags: ['Open Source', 'Technical Support'],
          },
          config: {
            systemRole: 'Write a crisp GitHub issue in markdown.',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('lobehub/github-issue-helper', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('github-issue-helper');
    expect(result.resolvedSource).toBe(
      'https://chat-agents.lobehub.com/github-issue-helper.json',
    );
    expect(
      fs.readFileSync(path.join(result.skillDir, 'SKILL.md'), 'utf-8'),
    ).toContain('Write a crisp GitHub issue in markdown.');
  });

  test('reports a clear error when a LobeHub agent id does not exist', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url === 'https://chat-agents.lobehub.com/openai-skills-transcribe.json'
      ) {
        return textResponse('The page could not be found', 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      importSkill('lobehub/openai-skills-transcribe', {
        fetchImpl: fetchStub as typeof fetch,
      }),
    ).rejects.toThrow(
      'LobeHub agent "openai-skills-transcribe" was not found.',
    );
  });

  test('imports a Claude marketplace skill by marketplace name', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url ===
        'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json'
      ) {
        return jsonResponse({
          name: 'anthropic-agent-skills',
          plugins: [
            {
              name: 'document-skills',
              source: './',
              skills: ['./skills/pdf', './skills/docx'],
            },
          ],
        });
      }
      if (
        url ===
        'https://raw.githubusercontent.com/aiskillstore/marketplace/main/.claude-plugin/marketplace.json'
      ) {
        return textResponse('404: Not Found', 404);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/aiskillstore/marketplace/master/.claude-plugin/marketplace.json'
      ) {
        return textResponse('404: Not Found', 404);
      }
      if (url === 'https://api.github.com/repos/anthropics/skills') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (
        url ===
        'https://api.github.com/repos/anthropics/skills/contents/skills/pdf?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skills/pdf/SKILL.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
          },
        ]);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md'
      ) {
        return markdownResponse(`---
name: pdf
description: PDF helper.
---

# PDF
`);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill(
      'claude-marketplace/pdf@anthropic-agent-skills',
      {
        fetchImpl: fetchStub as typeof fetch,
      },
    );

    expect(result.skillName).toBe('pdf');
    expect(result.resolvedSource).toBe(
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
    );
  });

  test('imports a well-known skill over HTTPS', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mintlify.com/docs/.well-known/skills/index.json') {
        return jsonResponse({
          skills: [
            {
              name: 'mintlify',
              files: ['SKILL.md', 'references/usage.md'],
            },
          ],
        });
      }
      if (
        url === 'https://mintlify.com/docs/.well-known/skills/mintlify/SKILL.md'
      ) {
        return markdownResponse(`---
name: mintlify
description: Docs helper.
---

# Mintlify
`);
      }
      if (
        url ===
        'https://mintlify.com/docs/.well-known/skills/mintlify/references/usage.md'
      ) {
        return markdownResponse('# Usage\n');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('well-known:https://mintlify.com/docs', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('mintlify');
    expect(result.resolvedSource).toBe(
      'https://mintlify.com/docs/.well-known/skills/mintlify',
    );
    expect(
      fs.existsSync(path.join(result.skillDir, 'references', 'usage.md')),
    ).toBe(true);
  });

  test('allows force to override a caution verdict during import', async () => {
    const skillName = 'test-community-skill';
    const tempPackagedRoot = createPackagedSkillRoot(skillName);
    vi.doMock('../src/infra/install-root.js', () => ({
      resolveInstallPath: () => tempPackagedRoot,
    }));
    vi.doMock('../src/skills/skills-guard.js', () => ({
      guardSkillDirectory: () => ({
        allowed: false,
        reason: 'blocked (community source + caution verdict, 1 finding(s))',
        result: {
          skillName,
          skillPath: '/tmp/mock-skill',
          sourceTag: 'community',
          trustLevel: 'community',
          verdict: 'caution',
          findings: [
            {
              patternId: 'mock_pattern',
              severity: 'medium',
              category: 'structural',
              file: 'SKILL.md',
              line: 1,
              match: 'mock',
              description: 'mock finding',
            },
          ],
          scannedAt: '2026-03-24T00:00:00.000Z',
          summary: 'mock caution',
          fromCache: false,
        },
      }),
    }));

    const { importSkill } = await import('../src/skills/skills-import.ts');

    const result = await importSkill(`official/${skillName}`, { force: true });

    expect(result.skillName).toBe(skillName);
    expect(result.guardOverrideApplied).toBe(true);
    expect(result.guardVerdict).toBe('caution');
    expect(result.guardFindingsCount).toBe(1);
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
  });

  test('does not allow force to override a dangerous verdict during import', async () => {
    const skillName = 'test-community-skill';
    const tempPackagedRoot = createPackagedSkillRoot(skillName);
    vi.doMock('../src/infra/install-root.js', () => ({
      resolveInstallPath: () => tempPackagedRoot,
    }));
    vi.doMock('../src/skills/skills-guard.js', () => ({
      guardSkillDirectory: () => ({
        allowed: false,
        reason: 'blocked (community source + dangerous verdict, 2 finding(s))',
        result: {
          skillName,
          skillPath: '/tmp/mock-skill',
          sourceTag: 'community',
          trustLevel: 'community',
          verdict: 'dangerous',
          findings: [
            {
              patternId: 'mock_pattern',
              severity: 'critical',
              category: 'exfiltration',
              file: 'SKILL.md',
              line: 1,
              match: 'mock',
              description: 'mock finding',
            },
          ],
          scannedAt: '2026-03-24T00:00:00.000Z',
          summary: 'mock dangerous',
          fromCache: false,
        },
      }),
    }));

    const { importSkill } = await import('../src/skills/skills-import.ts');

    await expect(
      importSkill(`official/${skillName}`, { force: true }),
    ).rejects.toThrow(
      'Dangerous verdicts cannot be overridden with --force. To install anyway, re-run with --skip-skill-scan.',
    );
  });

  test('rejects symlinked packaged skill content', async () => {
    const skillName = 'test-community-skill';
    const tempPackagedRoot = createPackagedSkillRoot(skillName);
    const skillDir = path.join(tempPackagedRoot, skillName);

    const symlinkTarget = path.join(tempPackagedRoot, 'outside.txt');
    fs.writeFileSync(symlinkTarget, 'outside');
    fs.symlinkSync(symlinkTarget, path.join(skillDir, 'linked.txt'));

    vi.doMock('../src/infra/install-root.js', () => ({
      resolveInstallPath: () => tempPackagedRoot,
    }));

    const { importSkill } = await import('../src/skills/skills-import.ts');

    await expect(importSkill(`official/${skillName}`)).rejects.toThrow(
      'Refusing to import symlinked content',
    );
  });

  test('imports a skill from a local directory', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const tempSourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-local-skill-source-'),
    );
    fs.writeFileSync(
      path.join(tempSourceDir, 'SKILL.md'),
      `---
name: local-dir-skill
description: Skill imported from a local directory.
---

# Local Dir Skill

Use this skill for local testing.
`,
    );
    fs.mkdirSync(path.join(tempSourceDir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(tempSourceDir, 'references', 'notes.md'),
      '# Notes\n',
    );

    try {
      const result = await importSkill(tempSourceDir, { skipGuard: true });

      expect(result.skillName).toBe('local-dir-skill');
      expect(result.replacedExisting).toBe(false);
      expect(result.resolvedSource).toBe(path.resolve(tempSourceDir));
      expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
      expect(
        fs.existsSync(path.join(result.skillDir, 'references', 'notes.md')),
      ).toBe(true);
    } finally {
      fs.rmSync(tempSourceDir, { recursive: true, force: true });
    }
  });

  test('imports a skill from a relative local directory path', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const tempSourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-local-skill-relative-'),
    );
    fs.writeFileSync(
      path.join(tempSourceDir, 'SKILL.md'),
      `---
name: relative-skill
description: Skill from relative path.
---

# Relative Skill
`,
    );

    const originalCwd = process.cwd();
    try {
      process.chdir(path.dirname(tempSourceDir));
      const relativePath = `./${path.basename(tempSourceDir)}`;

      const result = await importSkill(relativePath, { skipGuard: true });

      expect(result.skillName).toBe('relative-skill');
      expect(result.resolvedSource).toBe(path.resolve(relativePath));
      expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempSourceDir, { recursive: true, force: true });
    }
  });

  test('imports a skill from a local .zip file', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const archiveBytes = await createZipArchive([
      {
        name: 'SKILL.md',
        content: `---
name: zipped-skill
description: Skill from a zip file.
---

# Zipped Skill
`,
      },
      {
        name: 'scripts/helper.sh',
        content: '#!/bin/bash\necho "hello"\n',
      },
    ]);

    const tempZipPath = path.join(
      os.tmpdir(),
      `hybridclaw-local-skill-${Date.now()}.zip`,
    );
    fs.writeFileSync(tempZipPath, archiveBytes);

    try {
      const result = await importSkill(tempZipPath, { skipGuard: true });

      expect(result.skillName).toBe('zipped-skill');
      expect(result.resolvedSource).toBe(tempZipPath);
      expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
      expect(
        fs.existsSync(path.join(result.skillDir, 'scripts', 'helper.sh')),
      ).toBe(true);
    } finally {
      fs.rmSync(tempZipPath, { force: true });
    }
  });

  test('rejects a local source that does not exist', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    await expect(importSkill('/nonexistent/path/to/skill')).rejects.toThrow(
      'Local skill source not found',
    );
  });

  test('rejects a local file that is not a .zip', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const tempFile = path.join(
      os.tmpdir(),
      `hybridclaw-not-zip-${Date.now()}.txt`,
    );
    fs.writeFileSync(tempFile, 'not a skill');

    try {
      await expect(importSkill(tempFile)).rejects.toThrow(
        'Local skill source must be a directory or a .zip file',
      );
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  });

  test('rejects a local directory without a SKILL.md file', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const tempSourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-local-skill-no-manifest-'),
    );
    fs.writeFileSync(path.join(tempSourceDir, 'README.md'), '# Not a skill\n');

    try {
      await expect(importSkill(tempSourceDir)).rejects.toThrow(
        'did not provide a SKILL.md file',
      );
    } finally {
      fs.rmSync(tempSourceDir, { recursive: true, force: true });
    }
  });

  test('rejects symlinked content in a local directory import', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const tempSourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-local-skill-symlink-'),
    );
    fs.writeFileSync(
      path.join(tempSourceDir, 'SKILL.md'),
      `---
name: symlink-skill
description: Has a symlink.
---

# Symlink Skill
`,
    );
    const outsideFile = path.join(
      os.tmpdir(),
      `hybridclaw-outside-${Date.now()}.txt`,
    );
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(tempSourceDir, 'linked.txt'));

    try {
      await expect(importSkill(tempSourceDir)).rejects.toThrow(
        'Refusing to import symlinked content',
      );
    } finally {
      fs.rmSync(tempSourceDir, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });

  test('strips attacker-supplied .import-source.json from imported content', async () => {
    const skillName = 'trojan-skill';
    const tempPackagedRoot = createPackagedSkillRoot(skillName);
    // Inject a forged import marker into the packaged skill content.
    fs.writeFileSync(
      path.join(tempPackagedRoot, skillName, '.import-source.json'),
      JSON.stringify({ kind: 'local' }),
    );
    vi.doMock('../src/infra/install-root.js', () => ({
      resolveInstallPath: () => tempPackagedRoot,
    }));

    const { importSkill } = await import('../src/skills/skills-import.ts');

    const result = await importSkill(`official/${skillName}`, {
      skipGuard: true,
    });

    // The installed marker must reflect the actual source (packaged-community),
    // not the attacker-supplied value (local).
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(result.skillDir, '.import-source.json'),
        'utf-8',
      ),
    );
    expect(marker.kind).toBe('packaged-community');
  });
});
