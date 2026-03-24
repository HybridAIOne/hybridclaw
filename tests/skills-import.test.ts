import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

describe('skill import', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

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

  test('imports a packaged community skill by name', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');

    expect(loadSkillCatalog().some((skill) => skill.name === 'himalaya')).toBe(
      false,
    );

    const result = await importSkill('himalaya');

    expect(result.skillName).toBe('himalaya');
    expect(result.replacedExisting).toBe(false);
    expect(result.resolvedSource).toBe('official/himalaya');
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);

    const importedSkill = loadSkillCatalog().find(
      (skill) => skill.name === 'himalaya',
    );
    expect(importedSkill?.source).toBe('community');
    expect(importedSkill?.metadata.hybridclaw.install).toMatchObject([
      {
        id: 'brew',
        kind: 'brew',
        formula: 'himalaya',
      },
    ]);
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

  test('imports a skills.sh alias by resolving the backing repo skill name', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url ===
        'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices'
      ) {
        return textResponse(
          '<button><code>npx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices</code></button>',
          200,
          'text/html; charset=utf-8',
        );
      }
      if (url === 'https://api.github.com/repos/vercel-labs/agent-skills') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (
        url ===
          'https://api.github.com/repos/vercel-labs/agent-skills/contents/vercel-react-best-practices?ref=main' ||
        url ===
          'https://api.github.com/repos/vercel-labs/agent-skills/contents/skills/vercel-react-best-practices?ref=main' ||
        url ===
          'https://api.github.com/repos/vercel-labs/agent-skills/contents/vercel-react-best-practices/SKILL.md?ref=main' ||
        url ===
          'https://api.github.com/repos/vercel-labs/agent-skills/contents/skills/vercel-react-best-practices/SKILL.md?ref=main'
      ) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (
        url ===
        'https://api.github.com/repos/vercel-labs/agent-skills/git/trees/main?recursive=1'
      ) {
        return jsonResponse({
          truncated: false,
          tree: [
            {
              path: 'skills/react-best-practices/SKILL.md',
              type: 'blob',
            },
          ],
        });
      }
      if (
        url ===
        'https://api.github.com/repos/vercel-labs/agent-skills/contents/skills/react-best-practices/SKILL.md?ref=main'
      ) {
        return jsonResponse({
          name: 'SKILL.md',
          path: 'skills/react-best-practices/SKILL.md',
          type: 'file',
          content: Buffer.from(`---
name: vercel-react-best-practices
description: React guidance.
---

# Vercel React Best Practices
`)
            .toString('base64')
            .replace(/(.{76})/g, '$1\n'),
        });
      }
      if (
        url ===
        'https://api.github.com/repos/vercel-labs/agent-skills/contents/skills/react-best-practices?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skills/react-best-practices/SKILL.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md',
          },
          {
            name: 'rules',
            path: 'skills/react-best-practices/rules',
            type: 'dir',
          },
        ]);
      }
      if (
        url ===
        'https://api.github.com/repos/vercel-labs/agent-skills/contents/skills/react-best-practices/rules?ref=main'
      ) {
        return jsonResponse([
          {
            name: 'async-parallel.md',
            path: 'skills/react-best-practices/rules/async-parallel.md',
            type: 'file',
            download_url:
              'https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/rules/async-parallel.md',
          },
        ]);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md'
      ) {
        return markdownResponse(`---
name: vercel-react-best-practices
description: React guidance.
---

# Vercel React Best Practices
`);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/rules/async-parallel.md'
      ) {
        return markdownResponse('# async-parallel\n');
      }
      if (
        url.startsWith(
          'https://api.github.com/repos/vercel-labs/agent-skills/contents/',
        )
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
      'https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices',
    );
    expect(
      fs.existsSync(path.join(result.skillDir, 'rules', 'async-parallel.md')),
    ).toBe(true);
  });

  test('imports a well-known skill and normalizes skill.md casing', async () => {
    const { importSkill } = await import('../src/skills/skills-import.ts');

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mintlify.com/docs/.well-known/skills/index.json') {
        return jsonResponse({
          skills: [
            {
              name: 'mintlify',
              files: ['skill.md', 'references/checklist.md'],
            },
          ],
        });
      }
      if (
        url === 'https://mintlify.com/docs/.well-known/skills/mintlify/skill.md'
      ) {
        return markdownResponse(`---
name: mintlify
description: Mintlify docs helper.
---

# Mintlify
`);
      }
      if (
        url ===
        'https://mintlify.com/docs/.well-known/skills/mintlify/references/checklist.md'
      ) {
        return markdownResponse('# Checklist\n');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await importSkill('well-known:https://mintlify.com/docs', {
      fetchImpl: fetchStub as typeof fetch,
    });

    expect(result.skillName).toBe('mintlify');
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(result.skillDir, 'references', 'checklist.md')),
    ).toBe(true);
  });
});
