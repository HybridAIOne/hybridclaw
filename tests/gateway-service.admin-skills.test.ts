import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import * as yazl from 'yazl';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';
import { useTempDir } from './test-utils.ts';

const ORIGINAL_CWD = process.cwd();

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const makeTempDir = useTempDir();

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-admin-skills-',
  cleanup: () => {
    runAgentMock.mockReset();
    vi.doUnmock('../src/skills/skills-guard.js');
    process.chdir(ORIGINAL_CWD);
  },
});

function setupProjectCwd(): string {
  const homeDir = setupHome();
  makeTempDir.track(homeDir);
  const projectDir = path.join(homeDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  process.chdir(projectDir);
  return projectDir;
}

async function createZipArchive(
  entries: Array<{ name: string; content: string | Buffer }>,
): Promise<Buffer> {
  const archivePath = path.join(
    os.tmpdir(),
    `hybridclaw-gateway-admin-skills-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`,
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
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

test('createGatewayAdminSkill stages outside skills/ before publishing the skill', async () => {
  const projectDir = setupProjectCwd();

  const { createGatewayAdminSkill } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const result = createGatewayAdminSkill({
    name: 'my-skill',
    description: 'A test skill.',
    category: 'memory',
    shortDescription: 'Quick summary',
    userInvocable: true,
    disableModelInvocation: false,
    tags: ['test'],
    body: '# My Skill\n\nUse this skill for testing.',
    files: [{ path: 'scripts/run.mjs', content: 'console.log("ok");\n' }],
  });

  const skillDir = path.join(projectDir, 'skills', 'my-skill');
  expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain(
    'name: my-skill',
  );
  expect(
    fs.readFileSync(path.join(skillDir, 'scripts', 'run.mjs'), 'utf-8'),
  ).toBe('console.log("ok");\n');
  expect(result.skills.some((skill) => skill.name === 'my-skill')).toBe(true);
  expect(
    fs
      .readdirSync(projectDir)
      .filter((entry) => entry.startsWith('.my-skill.create-')),
  ).toEqual([]);
});

test('createGatewayAdminSkill preserves a competing skill when the final rename loses the race', async () => {
  const projectDir = setupProjectCwd();

  const { GatewayRequestError } = await import(
    '../src/errors/gateway-request-error.ts'
  );
  const { createGatewayAdminSkill } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const skillDir = path.join(projectDir, 'skills', 'my-skill');
  const originalRenameSync = fs.renameSync;
  vi.spyOn(fs, 'renameSync')
    .mockImplementationOnce((_oldPath, _newPath) => {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'existing skill\n');
      const error = new Error('target exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    })
    .mockImplementation((oldPath, newPath) =>
      originalRenameSync(oldPath, newPath),
    );

  try {
    createGatewayAdminSkill({
      name: 'my-skill',
      description: 'A test skill.',
      category: 'memory',
      body: '# My Skill\n\nUse this skill for testing.',
    });
    throw new Error('Expected createGatewayAdminSkill to throw.');
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect((error as InstanceType<typeof GatewayRequestError>).statusCode).toBe(
      409,
    );
    expect((error as Error).message).toContain(
      'Skill `my-skill` already exists',
    );
  }

  expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
    'existing skill\n',
  );
  expect(
    fs
      .readdirSync(projectDir)
      .filter((entry) => entry.startsWith('.my-skill.create-')),
  ).toEqual([]);
});

test('uploadGatewayAdminSkillZip rejects corrupt archives as a bad request', async () => {
  setupProjectCwd();

  const { GatewayRequestError } = await import(
    '../src/errors/gateway-request-error.ts'
  );
  const { uploadGatewayAdminSkillZip } = await import(
    '../src/gateway/gateway-service.ts'
  );

  try {
    await uploadGatewayAdminSkillZip(Buffer.from('not-a-zip'));
    throw new Error('Expected uploadGatewayAdminSkillZip to throw.');
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect((error as InstanceType<typeof GatewayRequestError>).statusCode).toBe(
      400,
    );
    expect((error as Error).message).toBe(
      'Uploaded file is not a valid skill ZIP archive.',
    );
  }
});

test('createGatewayAdminSkill rejects blocked skills before publishing them', async () => {
  const projectDir = setupProjectCwd();
  vi.doMock('../src/skills/skills-guard.js', () => ({
    guardSkillDirectory: () => ({
      allowed: false,
      reason: 'blocked (workspace source + dangerous verdict, 2 finding(s))',
      result: {
        skillName: 'my-skill',
        skillPath: '/tmp/mock-skill',
        sourceTag: 'workspace',
        trustLevel: 'workspace',
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
        scannedAt: '2026-04-08T00:00:00.000Z',
        summary: 'mock dangerous',
        fromCache: false,
      },
    }),
  }));

  const { GatewayRequestError } = await import(
    '../src/errors/gateway-request-error.ts'
  );
  const { createGatewayAdminSkill } = await import(
    '../src/gateway/gateway-service.ts'
  );

  try {
    createGatewayAdminSkill({
      name: 'my-skill',
      description: 'A blocked test skill.',
      category: 'memory',
      body: '# My Skill\n\nUse this skill for testing.',
    });
    throw new Error('Expected createGatewayAdminSkill to throw.');
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect((error as InstanceType<typeof GatewayRequestError>).statusCode).toBe(
      400,
    );
    expect((error as Error).message).toBe(
      'Skill `my-skill` was blocked by the security scanner: blocked (workspace source + dangerous verdict, 2 finding(s)).',
    );
  }

  expect(fs.existsSync(path.join(projectDir, 'skills', 'my-skill'))).toBe(
    false,
  );
  expect(
    fs
      .readdirSync(projectDir)
      .filter((entry) => entry.startsWith('.my-skill.create-')),
  ).toEqual([]);
});

test('uploadGatewayAdminSkillZip accepts wrapped archives with macOS metadata entries', async () => {
  const projectDir = setupProjectCwd();

  const { uploadGatewayAdminSkillZip } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const zipBuffer = await createZipArchive([
    {
      name: 'my-skill/SKILL.md',
      content: `---
name: my-skill
description: Wrapped skill upload test
---

# My Skill
`,
    },
    {
      name: 'my-skill/scripts/run.mjs',
      content: 'console.log("wrapped");\n',
    },
    {
      name: '__MACOSX/ignored.txt',
      content: 'ignore me',
    },
    {
      name: '.DS_Store',
      content: 'finder-metadata',
    },
  ]);

  const result = await uploadGatewayAdminSkillZip(zipBuffer);

  const skillDir = path.join(projectDir, 'skills', 'my-skill');
  expect(result.skills.some((skill) => skill.name === 'my-skill')).toBe(true);
  expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
  expect(
    fs.readFileSync(path.join(skillDir, 'scripts', 'run.mjs'), 'utf-8'),
  ).toBe('console.log("wrapped");\n');
  expect(fs.existsSync(path.join(projectDir, 'skills', '__MACOSX'))).toBe(
    false,
  );
  expect(fs.existsSync(path.join(projectDir, 'skills', '.DS_Store'))).toBe(
    false,
  );
});

test('uploadGatewayAdminSkillZip rejects blocked skills before installation', async () => {
  const projectDir = setupProjectCwd();
  vi.doMock('../src/skills/skills-guard.js', () => ({
    guardSkillDirectory: () => ({
      allowed: false,
      reason: 'blocked (workspace source + dangerous verdict, 2 finding(s))',
      result: {
        skillName: 'my-skill',
        skillPath: '/tmp/mock-skill',
        sourceTag: 'workspace',
        trustLevel: 'workspace',
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
        scannedAt: '2026-04-08T00:00:00.000Z',
        summary: 'mock dangerous',
        fromCache: false,
      },
    }),
  }));

  const { GatewayRequestError } = await import(
    '../src/errors/gateway-request-error.ts'
  );
  const { uploadGatewayAdminSkillZip } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const zipBuffer = await createZipArchive([
    {
      name: 'my-skill/SKILL.md',
      content: `---
name: my-skill
description: Blocked skill upload test
---

# My Skill
`,
    },
  ]);

  try {
    await uploadGatewayAdminSkillZip(zipBuffer);
    throw new Error('Expected uploadGatewayAdminSkillZip to throw.');
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect((error as InstanceType<typeof GatewayRequestError>).statusCode).toBe(
      400,
    );
    expect((error as Error).message).toBe(
      'Skill `my-skill` was blocked by the security scanner: blocked (workspace source + dangerous verdict, 2 finding(s)).',
    );
  }

  expect(fs.existsSync(path.join(projectDir, 'skills', 'my-skill'))).toBe(
    false,
  );
});
