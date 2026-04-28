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
    const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
    const auditLines = fs
      .readFileSync(getAuditWirePath('skill-lifecycle'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: Record<string, unknown> });
    const lifecycleAuditEvent = auditLines.find(
      (line) => line.event?.type === 'skill.lifecycle',
    )?.event;
    expect(JSON.stringify(lifecycleAuditEvent)).not.toContain(
      'SALESFORCE_TOKEN',
    );
    expect(lifecycleAuditEvent?.requiredCredentials).toEqual([
      {
        id: 'salesforce',
        required: true,
      },
    ]);

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
      source: installed.resolvedSource,
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
      source: upgraded.resolvedSource,
    });
    const upgradedSource = config.getRuntimeConfig().skills.installed[0].source;

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
      source: upgradedSource,
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
      source: upgradedSource,
    });
  });

  test('upgrade rejects skills that are not currently installed', async () => {
    const sourceRoot = path.join(tempHome, 'sources');
    const skillV1 = writeSkillSource({
      rootDir: sourceRoot,
      name: 'deal-desk',
      version: '1.0.0',
    });

    const lifecycle = await import('../src/skills/skills-lifecycle.ts');
    const config = await import('../src/config/runtime-config.ts');
    await expect(
      lifecycle.upgradeSkillPackage(skillV1, {
        actor: 'test',
        homeDir: tempHome,
      }),
    ).rejects.toThrow(
      'Cannot upgrade skill package "deal-desk" because it is not installed. Run skill install <source> first.',
    );
    expect(fs.existsSync(path.join(tempHome, 'skills', 'deal-desk'))).toBe(
      false,
    );
    expect(config.getRuntimeConfig().skills.installed).toHaveLength(0);

    await lifecycle.installSkillPackage(skillV1, {
      actor: 'test',
      homeDir: tempHome,
    });
    lifecycle.uninstallSkillPackage('deal-desk', {
      actor: 'test',
      homeDir: tempHome,
    });
    const skillV2 = writeSkillSource({
      rootDir: sourceRoot,
      name: 'deal-desk',
      version: '2.0.0',
    });

    await expect(
      lifecycle.upgradeSkillPackage(skillV2, {
        actor: 'test',
        homeDir: tempHome,
      }),
    ).rejects.toThrow(
      'Cannot upgrade skill package "deal-desk" because it is not installed. Run skill install <source> first.',
    );
    expect(
      config.getRuntimeConfig().skills.installed.find(
        (entry) => entry.id === 'deal-desk',
      ),
    ).toMatchObject({
      status: 'uninstalled',
    });
    expect(
      fs.existsSync(path.join(tempHome, 'skills', 'deal-desk')),
    ).toBe(false);
  });

  test('global enable and disable require installed records for managed community skills', async () => {
    const managedRoot = path.join(tempHome, 'skills');
    writeSkillSource({
      rootDir: managedRoot,
      name: 'manual-skill',
      version: '1.0.0',
    });

    const lifecycle = await import('../src/skills/skills-lifecycle.ts');
    const config = await import('../src/config/runtime-config.ts');
    expect(() =>
      lifecycle.setSkillPackageEnabled({
        skillName: 'manual-skill',
        enabled: false,
        actor: 'test',
      }),
    ).toThrow(
      'Cannot disable skill package "manual-skill" because it does not have an installed package record.',
    );
    expect(config.getRuntimeConfig().skills.disabled).not.toContain(
      'manual-skill',
    );

    const sourceRoot = path.join(tempHome, 'sources');
    const skillV1 = writeSkillSource({
      rootDir: sourceRoot,
      name: 'managed-skill',
      version: '1.0.0',
    });
    await lifecycle.installSkillPackage(skillV1, {
      actor: 'test',
      homeDir: tempHome,
    });

    const disabled = lifecycle.setSkillPackageEnabled({
      skillName: 'managed-skill',
      enabled: false,
      actor: 'test',
    });
    expect(disabled).toMatchObject({
      action: 'disable',
      skillName: 'managed-skill',
      scope: 'global',
    });
    expect(
      config.getRuntimeConfig().skills.installed.find(
        (entry) => entry.id === 'managed-skill',
      ),
    ).toMatchObject({
      status: 'disabled',
    });
    expect(config.getRuntimeConfig().skills.disabled).toContain(
      'managed-skill',
    );

    const enabled = lifecycle.setSkillPackageEnabled({
      skillName: 'managed-skill',
      enabled: true,
      actor: '   ',
    });
    expect(enabled.scope).toBe('global');
    expect(
      config.getRuntimeConfig().skills.installed.find(
        (entry) => entry.id === 'managed-skill',
      ),
    ).toMatchObject({
      status: 'enabled',
    });
    expect(config.getRuntimeConfig().skills.disabled).not.toContain(
      'managed-skill',
    );

    const slackDisabled = lifecycle.setSkillPackageEnabled({
      skillName: 'managed-skill',
      enabled: false,
      channelKind: 'slack',
      actor: 'test',
    });
    expect(slackDisabled).toMatchObject({
      action: 'disable',
      skillName: 'managed-skill',
      scope: 'slack',
    });
    expect(config.getRuntimeConfig().skills.channelDisabled?.slack).toContain(
      'managed-skill',
    );
    expect(
      config.getRuntimeConfig().skills.installed.find(
        (entry) => entry.id === 'managed-skill',
      ),
    ).toMatchObject({
      status: 'enabled',
    });

    const slackEnabled = lifecycle.setSkillPackageEnabled({
      skillName: 'managed-skill',
      enabled: true,
      channelKind: 'slack',
      actor: 'test',
    });
    expect(slackEnabled.scope).toBe('slack');
    expect(
      config.getRuntimeConfig().skills.channelDisabled?.slack || [],
    ).not.toContain('managed-skill');

    const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
    const auditEvents = fs
      .readFileSync(getAuditWirePath('skill-lifecycle'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: Record<string, unknown> })
      .map((line) => line.event)
      .filter((event) => event?.type === 'skill.lifecycle');
    expect(auditEvents.at(-3)).toMatchObject({
      action: 'enable',
      actor: 'skill-lifecycle',
      skillName: 'managed-skill',
    });
  });

  test('rollback rejects malformed snapshot file entries before restore', async () => {
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
    const revisionAssetPath = path.join(
      installed.skillDir,
      '.hybridclaw-skill-snapshot.json',
    );
    const validSnapshot = (label: string) =>
      JSON.stringify({
        schemaVersion: 1,
        manifest: installed.manifest,
        files: [
          {
            path: 'SKILL.md',
            mode: 0o644,
            contentBase64: Buffer.from(label).toString('base64'),
          },
        ],
      });
    const malformedFiles: Array<{ file: unknown; message: string }> = [
      {
        file: {
          path: null,
          mode: 0o644,
          contentBase64: Buffer.from('ok').toString('base64'),
        },
        message: 'Skill revision snapshot file #1 has invalid path.',
      },
      {
        file: {
          path: 'scripts/run.js',
          mode: 'rwxrwxrwx',
          contentBase64: Buffer.from('ok').toString('base64'),
        },
        message: 'Skill revision snapshot file #1 has invalid mode.',
      },
      {
        file: {
          path: 'scripts/run.js',
          mode: 0o755,
          contentBase64: 123,
        },
        message: 'Skill revision snapshot file #1 has invalid contentBase64.',
      },
    ];

    for (const [index, { file, message }] of malformedFiles.entries()) {
      config.syncRuntimeAssetRevisionState(
        'skill',
        revisionAssetPath,
        {
          actor: 'test',
          route: `test.skill.bad-snapshot.${index}`,
          source: 'test',
        },
        {
          exists: true,
          content: JSON.stringify({
            schemaVersion: 1,
            manifest: installed.manifest,
            files: [file],
          }),
        },
      );
      config.syncRuntimeAssetRevisionState(
        'skill',
        revisionAssetPath,
        {
          actor: 'test',
          route: `test.skill.after-bad-snapshot.${index}`,
          source: 'test',
        },
        {
          exists: true,
          content: validSnapshot(`after-${index}`),
        },
      );

      const revision = lifecycle.listSkillPackageRevisions('deal-desk')[0];
      expect(revision).toMatchObject({
        route: `test.skill.after-bad-snapshot.${index}`,
      });
      expect(() =>
        lifecycle.rollbackSkillPackage({
          skillName: 'deal-desk',
          revisionId: revision.id,
          actor: 'test',
          homeDir: tempHome,
        }),
      ).toThrow(message);
      expect(
        fs.readFileSync(
          path.join(installed.skillDir, 'scripts', 'run.js'),
          'utf-8',
        ),
      ).toBe('console.log("v1");\n');
    }
  });

  test('rollback caps restored file permissions from snapshot data', async () => {
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
    const revisionAssetPath = path.join(
      installed.skillDir,
      '.hybridclaw-skill-snapshot.json',
    );
    const snapshotWithMode = (mode: number, label: string) =>
      JSON.stringify({
        schemaVersion: 1,
        manifest: installed.manifest,
        files: [
          {
            path: 'SKILL.md',
            mode,
            contentBase64: fs
              .readFileSync(path.join(skillV1, 'SKILL.md'))
              .toString('base64'),
          },
          {
            path: 'scripts/run.js',
            mode,
            contentBase64: Buffer.from(label).toString('base64'),
          },
        ],
      });

    config.syncRuntimeAssetRevisionState(
      'skill',
      revisionAssetPath,
      {
        actor: 'test',
        route: 'test.skill.tampered-mode',
        source: 'test',
      },
      {
        exists: true,
        content: snapshotWithMode(0o777, 'console.log("tampered");\n'),
      },
    );
    config.syncRuntimeAssetRevisionState(
      'skill',
      revisionAssetPath,
      {
        actor: 'test',
        route: 'test.skill.after-tampered-mode',
        source: 'test',
      },
      {
        exists: true,
        content: snapshotWithMode(0o644, 'console.log("current");\n'),
      },
    );

    const revision = lifecycle.listSkillPackageRevisions('deal-desk')[0];
    expect(revision).toMatchObject({
      route: 'test.skill.after-tampered-mode',
    });

    lifecycle.rollbackSkillPackage({
      skillName: 'deal-desk',
      revisionId: revision.id,
      actor: 'test',
      homeDir: tempHome,
    });

    expect(
      fs.readFileSync(
        path.join(installed.skillDir, 'scripts', 'run.js'),
        'utf-8',
      ),
    ).toBe('console.log("tampered");\n');
    expect(
      fs.statSync(path.join(installed.skillDir, 'scripts', 'run.js')).mode &
        0o777,
    ).toBe(0o644);
    expect(
      fs.statSync(path.join(installed.skillDir, 'SKILL.md')).mode & 0o777,
    ).toBe(0o644);
  });

  test('install rejects packaged skills without a valid version', async () => {
    const sourceRoot = path.join(tempHome, 'sources');
    const skillDir = path.join(sourceRoot, 'versionless');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: versionless',
        'manifest:',
        '  id: versionless',
        '  capabilities: [crm.sync]',
        '---',
        '',
        '# Versionless',
      ].join('\n'),
      'utf-8',
    );

    const lifecycle = await import('../src/skills/skills-lifecycle.ts');
    await expect(
      lifecycle.installSkillPackage(skillDir, {
        actor: 'test',
        homeDir: tempHome,
        skipGuard: true,
      }),
    ).rejects.toThrow(
      'Skill manifest for "versionless" has missing version; packaged skills must declare a semantic version like 1.2.3.',
    );
    expect(fs.existsSync(path.join(tempHome, 'skills', 'versionless'))).toBe(
      false,
    );
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
