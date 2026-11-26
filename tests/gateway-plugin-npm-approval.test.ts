import { expect, test, vi } from 'vitest';
import { PluginNpmInstallApprovalRequiredError } from '../src/plugins/plugin-source.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  installPluginMock,
  pluginDependencyApprovalRequiredError,
  reloadPluginManagerMock,
} = vi.hoisted(() => {
  const pluginManager = {
    listPluginSummary: vi.fn(() => []),
  };
  return {
    installPluginMock: vi.fn(),
    reloadPluginManagerMock: vi.fn(async () => pluginManager),
    pluginDependencyApprovalRequiredError: class PluginDependencyApprovalRequiredError extends Error {
      readonly plan: {
        usesPackageJson: boolean;
        nodePackages: string[];
        pipPackages: string[];
      };

      constructor(plan: {
        usesPackageJson: boolean;
        nodePackages: string[];
        pipPackages: string[];
      }) {
        super('Plugin dependency installation requires explicit approval.');
        this.plan = plan;
      }
    },
  };
});

vi.mock('../src/plugins/plugin-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/plugins/plugin-manager.js')>();
  return {
    ...actual,
    reloadPluginManager: reloadPluginManagerMock,
  };
});

vi.mock('../src/plugins/plugin-install.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/plugins/plugin-install.js')>();
  return {
    ...actual,
    installPlugin: installPluginMock,
    PluginDependencyApprovalRequiredError:
      pluginDependencyApprovalRequiredError,
  };
});

const { setupHome } = setupGatewayTest({
  tempDirPrefix: 'hybridclaw-plugin-npm-approval-',
  cleanup: () => {
    installPluginMock.mockReset();
    reloadPluginManagerMock.mockClear();
  },
});

test('gateway npm registry install requires one-time approval and carries it across dependency approval', async () => {
  setupHome();

  installPluginMock
    .mockRejectedValueOnce(
      new PluginNpmInstallApprovalRequiredError('community-plugin'),
    )
    .mockRejectedValueOnce(
      new PluginNpmInstallApprovalRequiredError('community-plugin'),
    )
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: false,
        nodePackages: ['community-dep'],
        pipPackages: [],
      }),
    )
    .mockRejectedValueOnce(
      new PluginNpmInstallApprovalRequiredError('community-plugin'),
    )
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: false,
        nodePackages: ['community-dep'],
        pipPackages: [],
      }),
    )
    .mockResolvedValueOnce({
      pluginId: 'community-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/community-plugin',
      source: 'npm:community-plugin',
      alreadyInstalled: false,
      enabledInPlace: false,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: ['community-dep'],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: [],
      requiredConfigKeys: [],
    });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { handleTextChannelApprovalCommand } = await import(
    '../src/gateway/text-channel-commands.ts'
  );

  initDatabase({ quiet: true });

  const npmApproval = await handleGatewayCommand({
    sessionId: 'session-plugin-npm-approval',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['plugin', 'install', 'npm:community-plugin'],
  });

  expect(npmApproval.kind).toBe('info');
  expect(npmApproval).toMatchObject({ title: 'Pending Approval' });
  expect(npmApproval.text).toContain('community-plugin');
  expect(npmApproval.text).toContain(
    'Reply `yes for session` is unavailable for this approval.',
  );

  const depApproval = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-npm-approval',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'yes'],
  });
  expect(depApproval?.text).toContain('community-dep');

  const installed = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-npm-approval',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'yes'],
  });

  expect(installed?.text).toContain('Plugin Installed');
  expect(installPluginMock).toHaveBeenLastCalledWith('npm:community-plugin', {
    approveNpmInstall: true,
    approveDependencyInstall: true,
  });
});

test('denying dependency approval does not leave npm fetch pre-approved', async () => {
  setupHome();

  installPluginMock
    .mockRejectedValueOnce(
      new PluginNpmInstallApprovalRequiredError('community-plugin'),
    )
    .mockRejectedValueOnce(
      new PluginNpmInstallApprovalRequiredError('community-plugin'),
    )
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: false,
        nodePackages: ['community-dep'],
        pipPackages: [],
      }),
    )
    .mockRejectedValueOnce(
      new PluginNpmInstallApprovalRequiredError('community-plugin'),
    );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { handleTextChannelApprovalCommand } = await import(
    '../src/gateway/text-channel-commands.ts'
  );

  initDatabase({ quiet: true });

  await handleGatewayCommand({
    sessionId: 'session-plugin-npm-deny',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['plugin', 'install', 'npm:community-plugin'],
  });

  const depApproval = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-npm-deny',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'yes'],
  });
  expect(depApproval?.text).toContain('community-dep');

  const denied = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-npm-deny',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'no'],
  });
  expect(denied?.text).toContain('Cancelled plugin install');

  const secondAttempt = await handleGatewayCommand({
    sessionId: 'session-plugin-npm-deny',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['plugin', 'install', 'npm:community-plugin'],
  });
  expect(secondAttempt).toMatchObject({
    kind: 'info',
    title: 'Pending Approval',
  });
  expect(secondAttempt.text).toContain('community-plugin');
});
