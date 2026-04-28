import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

function writeSkillSource(params: {
  rootDir: string;
  name: string;
  version: string;
  scriptText?: string;
}): string {
  const skillDir = path.join(params.rootDir, params.name);
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${params.name}`,
      'description: Packaged skill for lifecycle tests.',
      'metadata:',
      '  hybridclaw:',
      `    id: ${params.name}`,
      `    version: ${params.version}`,
      '    capabilities:',
      '      - crm.sync',
      '      - proposals',
      '    required_credentials:',
      '      - id: salesforce',
      '        env: SALESFORCE_TOKEN',
      '    supported_channels:',
      '      - slack',
      '      - email',
      '---',
      '',
      `# ${params.name}`,
      '',
      `Version ${params.version}`,
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(skillDir, 'scripts', 'run.js'),
    params.scriptText || `console.log(${JSON.stringify(params.version)});\n`,
    'utf-8',
  );
  return skillDir;
}

describe('skill package lifecycle', () => {
  const originalHome = process.env.HOME;
  const originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-skill-lifecycle-'),
    );
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', tempHome);
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
    if (originalDataDir === undefined) {
      delete process.env.HYBRIDCLAW_DATA_DIR;
    } else {
      process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
    }
    if (originalDisableWatcher === undefined) {
      delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    } else {
      process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalDisableWatcher;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test('parses the business skill manifest schema from SKILL.md frontmatter', async () => {
    const { parseSkillManifestFromMarkdown } = await import(
      '../src/skills/skill-manifest.ts'
    );

    const manifest = parseSkillManifestFromMarkdown(
      [
        '---',
        'name: deal-desk',
        'description: Prepare deal desk packets.',
        'manifest:',
        '  id: revenue/deal-desk',
        '  version: 1.2.3',
        '  capabilities: [crm.sync, proposal.write]',
        '  required_credentials:',
        '    - id: salesforce',
        '      env: SALESFORCE_TOKEN',
        '  supported_channels: [slack, email, web]',
        '---',
        '',
        '# Deal Desk',
      ].join('\n'),
      { name: 'deal-desk' },
    );

    expect(manifest).toEqual({
      id: 'revenue-deal-desk',
      name: 'deal-desk',
      version: '1.2.3',
      capabilities: ['crm.sync', 'proposal.write'],
      requiredCredentials: [
        {
          id: 'salesforce',
          env: 'SALESFORCE_TOKEN',
          required: true,
        },
      ],
      supportedChannels: ['slack', 'email', 'tui'],
    });
  });

  test('install, upgrade, uninstall, and rollback are recorded as skill revisions', async () => {
    const sourceRoot = path.join(tempHome, 'sources');
    const skillV1 = writeSkillSource({
      rootDir: sourceRoot,
      name: 'deal-desk',
      version: '1.0.0',
      scriptText: 'console.log("v1");\n',
    });

    const lifecycle = await import('../src/skills/skills-lifecycle.ts');
    const config = await import('../src/config/runtime-config.ts');
    const installed = await lifecycle.installSkillPackage(skillV1, {
      actor: 'test',
      homeDir: tempHome,
    });

    expect(installed.manifest).toMatchObject({
      id: 'deal-desk',
      version: '1.0.0',
      capabilities: ['crm.sync', 'proposals'],
      supportedChannels: ['slack', 'email'],
    });
    expect(config.getRuntimeConfig().skills.installed).toHaveLength(1);
    expect(config.getRuntimeConfig().skills.installed[0]).toMatchObject({
      id: 'deal-desk',
      status: 'enabled',
      version: '1.0.0',
    });

    const skillV2 = writeSkillSource({
      rootDir: sourceRoot,
      name: 'deal-desk',
      version: '2.0.0',
      scriptText: 'console.log("v2");\n',
    });
    const upgraded = await lifecycle.upgradeSkillPackage(skillV2, {
      actor: 'test',
      homeDir: tempHome,
    });
    expect(upgraded.action).toBe('upgrade');
    expect(config.getRuntimeConfig().skills.installed[0]).toMatchObject({
      id: 'deal-desk',
      status: 'enabled',
      version: '2.0.0',
    });

    const upgradeRevisions = lifecycle.listSkillPackageRevisions('deal-desk');
    expect(upgradeRevisions).toHaveLength(1);

    const uninstalled = lifecycle.uninstallSkillPackage('deal-desk', {
      actor: 'test',
      homeDir: tempHome,
    });
    expect(fs.existsSync(uninstalled.skillDir)).toBe(false);
    expect(config.getRuntimeConfig().skills.installed[0]).toMatchObject({
      id: 'deal-desk',
      status: 'uninstalled',
    });

    const revisionsAfterUninstall =
      lifecycle.listSkillPackageRevisions('deal-desk');
    expect(revisionsAfterUninstall.length).toBeGreaterThanOrEqual(2);
    const latestRevision = revisionsAfterUninstall[0];
    const rolledBack = lifecycle.rollbackSkillPackage({
      skillName: 'deal-desk',
      revisionId: latestRevision.id,
      actor: 'test',
      homeDir: tempHome,
    });

    expect(rolledBack.manifest.version).toBe('2.0.0');
    expect(
      fs.readFileSync(path.join(rolledBack.skillDir, 'scripts', 'run.js'), 'utf-8'),
    ).toBe('console.log("v2");\n');
    expect(config.getRuntimeConfig().skills.installed[0]).toMatchObject({
      id: 'deal-desk',
      status: 'enabled',
      version: '2.0.0',
    });
  });

  test('uninstall refuses skills outside the managed package directory', async () => {
    const lifecycle = await import('../src/skills/skills-lifecycle.ts');

    expect(() =>
      lifecycle.uninstallSkillPackage('pdf', {
        actor: 'test',
        homeDir: tempHome,
      }),
    ).toThrow(/Refusing to modify non-managed skill package/);
  });
});
