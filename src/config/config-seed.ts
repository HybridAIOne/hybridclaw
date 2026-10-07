/**
 * Boot-time config seed: a container host passes deployment settings in
 * `HYBRIDCLAW_CONFIG_SEED` instead of running CLI commands after the gateway
 * is up. Each entry has the semantics of its CLI twin (`config set`,
 * `tool disable`, `skill disable`, `plugin reinstall`) and is applied before
 * the config watcher and plugin loader start, so nothing needs a reload.
 *
 * NOT a second config source: config.json stays the store of record, and an
 * entry that already holds writes nothing. A malformed seed fails the start.
 */
import { isDeepStrictEqual } from 'node:util';

import { listKnownToolNames } from '../agent/tool-summary.js';
import { logger } from '../logger.js';
import { reinstallPlugin } from '../plugins/plugin-install.js';
import { isRecord } from '../utils/type-guards.js';
import { CLOUD_DISABLED_SKILLS } from './cloud-defaults.js';
import {
  getRuntimeConfig,
  getRuntimeDisabledToolNames,
  getRuntimeSkillScopeDisabledNames,
  setRuntimeToolEnabled,
  updateRuntimeConfig,
} from './runtime-config.js';
import {
  getRuntimeConfigValueAtPath,
  setRuntimeConfigValueAtPath,
} from './runtime-config-edit.js';

const CONFIG_SEED_ENV = 'HYBRIDCLAW_CONFIG_SEED';

const SEED_ACTOR = 'config-seed';

interface ConfigSeed {
  set: Record<string, unknown>;
  disabledTools: string[];
  disabledSkills: string[];
  plugins: string[];
  pluginConfig?: Record<string, Record<string, unknown>>;
}

function parseNameList(raw: unknown, key: string): string[] {
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    !raw.every((item) => typeof item === 'string' && item.trim())
  ) {
    throw new Error(`${CONFIG_SEED_ENV}.${key} must be an array of names.`);
  }
  return raw.map((item: string) => item.trim());
}

export function parseConfigSeed(raw: string): ConfigSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_SEED_ENV} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${CONFIG_SEED_ENV} must be a JSON object.`);
  }
  const {
    set,
    disabledTools,
    disabledSkills,
    plugins,
    pluginConfig,
    ...unknownKeys
  } = parsed;
  const unknown = Object.keys(unknownKeys);
  if (unknown.length > 0) {
    throw new Error(
      `${CONFIG_SEED_ENV} has unknown keys: ${unknown.join(', ')}.`,
    );
  }
  if (set !== undefined && !isRecord(set)) {
    throw new Error(`${CONFIG_SEED_ENV}.set must map config keys to values.`);
  }
  if (
    pluginConfig !== undefined &&
    (!isRecord(pluginConfig) ||
      Object.entries(pluginConfig).some(
        ([id, value]) => !/^[a-z][a-z0-9-]*$/.test(id) || !isRecord(value),
      ))
  ) {
    throw new Error(
      `${CONFIG_SEED_ENV}.pluginConfig must map plugin IDs to objects.`,
    );
  }
  return {
    pluginConfig: pluginConfig as
      | Record<string, Record<string, unknown>>
      | undefined,
    set: set ?? {},
    disabledTools: parseNameList(disabledTools, 'disabledTools'),
    disabledSkills: parseNameList(disabledSkills, 'disabledSkills'),
    plugins: parseNameList(plugins, 'plugins'),
  };
}

export async function applyConfigSeed(seed: ConfigSeed): Promise<void> {
  const current = getRuntimeConfig();
  const changedKeys = Object.keys(seed.set).filter(
    (key) =>
      !isDeepStrictEqual(
        getRuntimeConfigValueAtPath(current, key),
        seed.set[key],
      ),
  );
  const knownTools = new Set(listKnownToolNames());
  const unknownTools = seed.disabledTools.filter(
    (name) => !knownTools.has(name),
  );
  if (unknownTools.length > 0) {
    throw new Error(`Unknown tool in ${CONFIG_SEED_ENV}: ${unknownTools[0]}`);
  }
  const disabledTools = getRuntimeDisabledToolNames(current);
  const toolsToDisable = seed.disabledTools.filter(
    (name) => !disabledTools.has(name),
  );
  if (changedKeys.length > 0 || toolsToDisable.length > 0) {
    updateRuntimeConfig(
      (draft) => {
        for (const key of changedKeys) {
          setRuntimeConfigValueAtPath(draft, key, seed.set[key]);
        }
        for (const name of toolsToDisable) {
          setRuntimeToolEnabled(draft, name, false);
        }
      },
      { route: SEED_ACTOR, source: 'internal' },
    );
  }

  const disabledSkills = getRuntimeSkillScopeDisabledNames(getRuntimeConfig());
  const cloudSkills =
    getRuntimeConfig().deployment.mode === 'cloud' ? CLOUD_DISABLED_SKILLS : [];
  const skillsToDisable = [
    ...new Set([...seed.disabledSkills, ...cloudSkills]),
  ].filter((name) => !disabledSkills.has(name));
  if (skillsToDisable.length > 0) {
    const { setSkillPackagesEnabled } = await import(
      '../skills/skills-lifecycle.js'
    );
    setSkillPackagesEnabled({
      skillNames: skillsToDisable,
      enabled: false,
      actor: SEED_ACTOR,
    });
  }

  const installedIds = new Set<string>();
  for (const source of seed.plugins) {
    const installed = await reinstallPlugin(source, {
      approveDependencyInstall: true,
    });
    installedIds.add(installed.pluginId);
  }

  const configs = seed.pluginConfig ?? {};
  const plugins = getRuntimeConfig().plugins.list;
  for (const id of Object.keys(configs)) {
    if (!installedIds.has(id) && !plugins.some((entry) => entry.id === id))
      throw new Error(`Config seed plugin "${id}" is not installed.`);
  }
  if (
    Object.entries(configs).some(([id, config]) => {
      const entry = plugins.find((plugin) => plugin.id === id);
      return (
        !entry ||
        !isDeepStrictEqual(entry.config, { ...entry.config, ...config })
      );
    })
  ) {
    updateRuntimeConfig(
      (draft) => {
        for (const [id, config] of Object.entries(configs)) {
          const entry = draft.plugins.list.find((plugin) => plugin.id === id);
          if (entry) entry.config = { ...entry.config, ...config };
          else draft.plugins.list.push({ id, enabled: true, config });
        }
      },
      { route: SEED_ACTOR, source: 'internal' },
    );
  }

  logger.info(
    {
      changedKeys,
      disabledTools: toolsToDisable,
      disabledSkills: skillsToDisable,
      plugins: seed.plugins,
    },
    'Applied config seed',
  );
}

export async function applyConfigSeedFromEnv(): Promise<void> {
  const raw = process.env[CONFIG_SEED_ENV]?.trim();
  if (!raw) return;
  await applyConfigSeed(parseConfigSeed(raw));
}
