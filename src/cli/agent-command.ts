import path from 'node:path';
import readline from 'node:readline/promises';

import {
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  runtimeConfigPath,
} from '../config/runtime-config.js';
import { normalizeArgs, parseValueFlag } from './common.js';
import { isHelpRequest, printAgentUsage } from './help.js';

async function ensureAgentPackagingRuntime(): Promise<void> {
  ensureRuntimeConfigFile();
  const { initDatabase, isDatabaseInitialized } = await import(
    '../memory/db.js'
  );
  const { initAgentRegistry } = await import('../agents/agent-registry.js');
  if (!isDatabaseInitialized()) {
    initDatabase({ quiet: true });
  }
  initAgentRegistry(getRuntimeConfig().agents);
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
  const answer = (await rl.question(`${question}${suffix}`))
    .trim()
    .toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

async function promptBundleMode(
  rl: readline.Interface,
  question: string,
): Promise<'bundle' | 'skip' | 'external'> {
  while (true) {
    const answer = (await rl.question(`${question} [yes/no/external] [yes]: `))
      .trim()
      .toLowerCase();
    if (!answer || answer === 'y' || answer === 'yes') {
      return 'bundle';
    }
    if (answer === 'n' || answer === 'no') {
      return 'skip';
    }
    if (answer === 'e' || answer === 'external') {
      return 'external';
    }
    console.log('Please answer yes, no, or external.');
  }
}

async function promptTrimmed(
  rl: readline.Interface,
  question: string,
  fallback = '',
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

export async function handleAgentPackageCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printAgentUsage();
    return;
  }

  await ensureAgentPackagingRuntime();

  const rawSub = normalized[0].toLowerCase();
  const sub =
    rawSub === 'pack' ? 'export' : rawSub === 'unpack' ? 'install' : rawSub;
  if (sub === 'list') {
    if (normalized.length !== 1) {
      printAgentUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw agent list`.',
      );
    }
    const { listAgents } = await import('../agents/agent-registry.js');
    for (const agent of listAgents()) {
      console.log(
        [
          agent.id,
          agent.name,
          typeof agent.model === 'string'
            ? agent.model
            : agent.model?.primary || '',
        ].join('\t'),
      );
    }
    return;
  }

  if (sub === 'inspect') {
    const archivePath = normalized[1];
    if (!archivePath) {
      printAgentUsage();
      throw new Error(
        'Missing archive path for `hybridclaw agent inspect <file.claw>`.',
      );
    }
    if (normalized.length !== 2) {
      printAgentUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw agent inspect <file.claw>`.',
      );
    }

    const { formatClawArchiveSummary, inspectClawArchive } = await import(
      '../agents/claw-archive.js'
    );
    const inspection = await inspectClawArchive(path.resolve(archivePath));
    console.log(formatClawArchiveSummary(inspection).join('\n'));
    return;
  }

  if (sub === 'export') {
    let agentId = 'main';
    let outputPath = '';
    let description = '';
    let author = '';
    let version = '';
    let dryRun = false;
    let skillMode = '';
    const selectedSkills: string[] = [];
    let pluginMode = '';
    const selectedPlugins: string[] = [];
    let positionalConsumed = false;

    for (let index = 1; index < normalized.length; index += 1) {
      const arg = normalized[index];
      const outputFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        names: ['-o', '--output'],
        placeholder: '<path>',
      });
      if (outputFlag) {
        outputPath = outputFlag.value;
        index = outputFlag.nextIndex;
        continue;
      }
      const descriptionFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--description',
        placeholder: '<text>',
      });
      if (descriptionFlag) {
        description = descriptionFlag.value;
        index = descriptionFlag.nextIndex;
        continue;
      }
      const authorFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--author',
        placeholder: '<text>',
      });
      if (authorFlag) {
        author = authorFlag.value;
        index = authorFlag.nextIndex;
        continue;
      }
      const versionFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--version',
        placeholder: '<value>',
      });
      if (versionFlag) {
        version = versionFlag.value;
        index = versionFlag.nextIndex;
        continue;
      }
      const skillsFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--skills',
        placeholder: '<ask|active|all|some>',
      });
      if (skillsFlag) {
        skillMode = skillsFlag.value;
        index = skillsFlag.nextIndex;
        continue;
      }
      const skillFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--skill',
        placeholder: '<name>',
      });
      if (skillFlag) {
        selectedSkills.push(
          ...skillFlag.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        );
        index = skillFlag.nextIndex;
        continue;
      }
      const pluginsFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--plugins',
        placeholder: '<ask|active|all|some>',
      });
      if (pluginsFlag) {
        pluginMode = pluginsFlag.value;
        index = pluginsFlag.nextIndex;
        continue;
      }
      const pluginFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--plugin',
        placeholder: '<id>',
      });
      if (pluginFlag) {
        selectedPlugins.push(
          ...pluginFlag.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        );
        index = pluginFlag.nextIndex;
        continue;
      }
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (!positionalConsumed && !arg.startsWith('-')) {
        agentId = arg;
        positionalConsumed = true;
        continue;
      }
      printAgentUsage();
      throw new Error(
        `Unexpected argument for \`hybridclaw agent export\`: ${arg}`,
      );
    }

    const { packAgent } = await import('../agents/claw-archive.js');
    const interactive =
      process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== 'true';
    const effectiveSkillMode = (skillMode || (interactive ? 'ask' : 'all'))
      .trim()
      .toLowerCase();
    const effectivePluginMode = (pluginMode || (interactive ? 'ask' : 'active'))
      .trim()
      .toLowerCase();
    if (
      effectiveSkillMode !== 'ask' &&
      effectiveSkillMode !== 'active' &&
      effectiveSkillMode !== 'all' &&
      effectiveSkillMode !== 'some'
    ) {
      throw new Error(
        `Unsupported \`--skills\` mode "${skillMode}". Use ask, active, all, or some.`,
      );
    }
    if (selectedSkills.length > 0 && effectiveSkillMode !== 'some') {
      throw new Error('`--skill <name>` requires `--skills some`.');
    }
    if (effectiveSkillMode === 'some' && selectedSkills.length === 0) {
      throw new Error(
        '`--skills some` requires at least one `--skill <name>` value.',
      );
    }
    if (effectiveSkillMode === 'ask' && !interactive) {
      throw new Error('`--skills ask` requires an interactive TTY.');
    }
    if (
      effectivePluginMode !== 'ask' &&
      effectivePluginMode !== 'active' &&
      effectivePluginMode !== 'all' &&
      effectivePluginMode !== 'some'
    ) {
      throw new Error(
        `Unsupported \`--plugins\` mode "${pluginMode}". Use ask, active, all, or some.`,
      );
    }
    if (selectedPlugins.length > 0 && effectivePluginMode !== 'some') {
      throw new Error('`--plugin <id>` requires `--plugins some`.');
    }
    if (effectivePluginMode === 'some' && selectedPlugins.length === 0) {
      throw new Error(
        '`--plugins some` requires at least one `--plugin <id>` value.',
      );
    }
    if (effectivePluginMode === 'ask' && !interactive) {
      throw new Error('`--plugins ask` requires an interactive TTY.');
    }
    const rl = interactive
      ? readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })
      : null;
    try {
      const result = await packAgent(agentId, {
        ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
        ...(description || author || version
          ? {
              manifestMetadata: {
                ...(description ? { description } : {}),
                ...(author ? { author } : {}),
                ...(version ? { version } : {}),
              },
            }
          : {}),
        ...(dryRun ? { dryRun: true } : {}),
        skillSelection: {
          mode: effectiveSkillMode,
          ...(selectedSkills.length > 0 ? { names: selectedSkills } : {}),
        },
        pluginSelection: {
          mode: effectivePluginMode,
          ...(selectedPlugins.length > 0 ? { names: selectedPlugins } : {}),
        },
        ...(rl
          ? {
              promptSelection: async (input) => {
                const bundleMode = await promptBundleMode(
                  rl,
                  input.kind === 'skill'
                    ? `Bundle workspace skill "${input.directoryName}"?`
                    : `Bundle installed plugin "${input.pluginId}"?`,
                );
                if (bundleMode === 'bundle') {
                  return { mode: 'bundle' as const };
                }
                if (bundleMode === 'skip') {
                  return { mode: 'skip' as const };
                }

                if (input.kind === 'skill') {
                  const ref = await promptTrimmed(
                    rl,
                    `Git reference for skill "${input.directoryName}"`,
                  );
                  if (!ref) {
                    throw new Error(
                      `Missing external reference for skill "${input.directoryName}".`,
                    );
                  }
                  const name = await promptTrimmed(
                    rl,
                    `Display name for skill "${input.directoryName}"`,
                    input.directoryName,
                  );
                  return {
                    mode: 'external' as const,
                    reference: {
                      kind: 'git',
                      ref,
                      ...(name ? { name } : {}),
                    },
                  };
                }

                const defaultKind = input.packageName ? 'npm' : 'local';
                const defaultRef = input.packageName || input.sourceDir;
                const kind = (
                  await promptTrimmed(
                    rl,
                    `External kind for plugin "${input.pluginId}" (npm|local)`,
                    defaultKind,
                  )
                ).toLowerCase();
                const ref = await promptTrimmed(
                  rl,
                  `Reference for plugin "${input.pluginId}"`,
                  defaultRef,
                );
                const pluginId = await promptTrimmed(
                  rl,
                  `Plugin id for "${input.pluginId}"`,
                  input.pluginId,
                );
                return {
                  mode: 'external' as const,
                  reference: {
                    kind: kind as 'npm' | 'local',
                    ref,
                    ...(pluginId ? { id: pluginId } : {}),
                  },
                };
              },
            }
          : {}),
      });

      console.log(
        dryRun
          ? `📦 Dry run export for agent ${result.manifest.name}: ${result.archivePath}.`
          : `📦 Exported agent ${result.manifest.name} to ${result.archivePath}.`,
      );
      console.log(`🧠 Workspace: ${result.workspacePath}`);
      console.log(`🧩 Bundled skills: ${result.bundledSkills.length}`);
      console.log(`🔌 Bundled plugins: ${result.bundledPlugins.length}`);
      if (
        result.externalSkills.length > 0 ||
        result.externalPlugins.length > 0
      ) {
        console.log(
          `🔗 External refs: ${result.externalSkills.length + result.externalPlugins.length}`,
        );
      }
      if (dryRun) {
        console.log('📄 Archive entries:');
        for (const entry of result.archiveEntries) {
          console.log(`  ${entry}`);
        }
      }
      return;
    } finally {
      rl?.close();
    }
  }

  if (sub === 'install') {
    let archivePath = '';
    let requestedId = '';
    let force = false;
    let skipExternals = false;
    let yes = false;

    for (let index = 1; index < normalized.length; index += 1) {
      const arg = normalized[index];
      if (!archivePath && !arg.startsWith('-')) {
        archivePath = arg;
        continue;
      }
      const idFlag = parseValueFlag({
        arg,
        args: normalized,
        index,
        name: '--id',
        placeholder: '<agent-id>',
      });
      if (idFlag) {
        requestedId = idFlag.value;
        index = idFlag.nextIndex;
        continue;
      }
      if (arg === '--force') {
        force = true;
        continue;
      }
      if (arg === '--skip-externals') {
        skipExternals = true;
        continue;
      }
      if (arg === '--yes') {
        yes = true;
        continue;
      }
      printAgentUsage();
      throw new Error(
        `Unexpected argument for \`hybridclaw agent install\`: ${arg}`,
      );
    }

    if (!archivePath) {
      printAgentUsage();
      throw new Error(
        'Missing archive path for `hybridclaw agent install <file.claw>`.',
      );
    }

    if (!yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error(
        'Install confirmation requires an interactive terminal. Re-run with --yes to skip the prompt.',
      );
    }

    const { formatClawArchiveSummary, unpackAgent } = await import(
      '../agents/claw-archive.js'
    );
    const result = await unpackAgent(path.resolve(archivePath), {
      ...(requestedId ? { agentId: requestedId } : {}),
      force,
      skipExternals,
      yes,
      confirm: async (inspection) => {
        console.log(formatClawArchiveSummary(inspection).join('\n'));
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          return await promptYesNo(
            rl,
            `Import this agent as "${requestedId || inspection.manifest.id || inspection.manifest.name}"?`,
            false,
          );
        } finally {
          rl.close();
        }
      },
    });

    console.log(
      `📥 Installed agent ${result.agentId} to ${result.workspacePath}.`,
    );
    console.log(`🧩 Bundled skills restored: ${result.bundledSkills.length}`);
    if (result.importedSkills.length > 0) {
      console.log(
        `🌐 Skill imports installed: ${result.importedSkills.length}`,
      );
    }
    console.log(
      `🔌 Bundled plugins installed: ${result.installedPlugins.length}`,
    );
    if (result.runtimeConfigChanged) {
      console.log(`⚙️ Updated runtime config at ${runtimeConfigPath()}.`);
    }
    if (result.externalActions.length > 0) {
      console.log('🔗 External references were not installed automatically:');
      for (const action of result.externalActions) {
        console.log(`  ${action}`);
      }
    }
    return;
  }

  if (sub === 'uninstall') {
    let targetAgentId = '';
    let yes = false;

    for (let index = 1; index < normalized.length; index += 1) {
      const arg = normalized[index];
      if (!targetAgentId && !arg.startsWith('-')) {
        targetAgentId = arg;
        continue;
      }
      if (arg === '--yes') {
        yes = true;
        continue;
      }
      printAgentUsage();
      throw new Error(
        `Unexpected argument for \`hybridclaw agent uninstall\`: ${arg}`,
      );
    }

    if (!targetAgentId) {
      printAgentUsage();
      throw new Error(
        'Missing agent id for `hybridclaw agent uninstall <agent-id>`.',
      );
    }

    if (!yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error(
        'Uninstall confirmation requires an interactive terminal. Re-run with --yes to skip the prompt.',
      );
    }

    const { getAgentById } = await import('../agents/agent-registry.js');
    const existingAgent = getAgentById(targetAgentId);

    if (!yes) {
      const targetLabel =
        existingAgent?.name && existingAgent.name !== targetAgentId
          ? `${existingAgent.name} (${targetAgentId})`
          : targetAgentId;
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const confirmed = await promptYesNo(
          rl,
          `Uninstall agent "${targetLabel}" and remove its workspace?`,
          false,
        );
        if (!confirmed) {
          throw new Error('Agent uninstall cancelled.');
        }
      } finally {
        rl.close();
      }
    }

    const { uninstallAgent } = await import('../agents/claw-archive.js');
    const result = uninstallAgent(targetAgentId, { existingAgent });
    console.log(`Uninstalled agent ${result.agentId}.`);
    console.log(
      result.removedAgentRoot
        ? `Removed agent files at ${result.agentRootPath}.`
        : `No agent files were present at ${result.agentRootPath}.`,
    );
    return;
  }

  printAgentUsage();
  throw new Error(
    `Unknown agent subcommand: ${rawSub}. Use \`hybridclaw agent export\`, \`hybridclaw agent inspect\`, \`hybridclaw agent install\`, or \`hybridclaw agent uninstall\`.`,
  );
}
