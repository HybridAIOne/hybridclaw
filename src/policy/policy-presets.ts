import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { resolveInstallPath } from '../infra/install-root.js';
import { type NetworkRule, normalizeNetworkRule } from './network-policy.js';
import {
  type IndexedNetworkRule,
  type ManagedNetworkRule,
  type PolicyNetworkState,
  readPolicyState,
  setPolicyPresets,
} from './policy-store.js';

export interface PolicyPreset {
  name: string;
  description: string;
  rules: NetworkRule[];
}

export interface PolicyPresetSummary {
  name: string;
  description: string;
}

const PRESETS_DIR = resolveInstallPath('presets');

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readPresetFile(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Preset name is required.');
  }
  const filePath = path.join(PRESETS_DIR, `${normalized}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Unknown policy preset: ${name}`);
  }
  return filePath;
}

function parsePresetFile(filePath: string): PolicyPreset {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = asRecord(parseYaml(raw));
  const name =
    String(parsed.name || path.basename(filePath, path.extname(filePath)))
      .trim()
      .toLowerCase() || path.basename(filePath, path.extname(filePath));
  const description = String(parsed.description || '').trim();
  const rules = Array.isArray(parsed.rules)
    ? parsed.rules
        .map((rule) =>
          normalizeNetworkRule(asRecord(rule) as Partial<NetworkRule>),
        )
        .filter((rule): rule is NetworkRule => Boolean(rule))
    : [];
  if (rules.length === 0) {
    throw new Error(`Policy preset "${name}" has no valid rules.`);
  }
  return {
    name,
    description,
    rules,
  };
}

export function listPolicyPresetSummaries(): PolicyPresetSummary[] {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .map((entry) => parsePresetFile(path.join(PRESETS_DIR, entry)))
    .map((preset) => ({
      name: preset.name,
      description: preset.description,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadPolicyPreset(name: string): PolicyPreset {
  return parsePresetFile(readPresetFile(name));
}

function networkRuleKey(rule: NetworkRule): string {
  return JSON.stringify({
    action: rule.action,
    host: rule.host,
    port: rule.port,
    methods: [...rule.methods],
    paths: [...rule.paths],
    agent: rule.agent,
  });
}

function stripRuleIndex(rule: IndexedNetworkRule): NetworkRule {
  return {
    action: rule.action,
    host: rule.host,
    port: rule.port,
    methods: [...rule.methods],
    paths: [...rule.paths],
    agent: rule.agent,
    ...(rule.comment ? { comment: rule.comment } : {}),
  };
}

function stripRuleIndexWithMetadata(
  rule: IndexedNetworkRule,
): ManagedNetworkRule {
  return {
    ...stripRuleIndex(rule),
    ...(rule.managedByPreset ? { managedByPreset: rule.managedByPreset } : {}),
  };
}

function collectPresetAddedRules(
  state: PolicyNetworkState,
  preset: PolicyPreset,
): ManagedNetworkRule[] {
  const currentPresetKeys = new Set(
    state.rules
      .filter((rule) => rule.managedByPreset === preset.name)
      .map((rule) => networkRuleKey(stripRuleIndex(rule))),
  );
  return preset.rules
    .filter((rule) => !currentPresetKeys.has(networkRuleKey(rule)))
    .map(
      (rule) =>
        ({
          ...rule,
          managedByPreset: preset.name,
        }) satisfies ManagedNetworkRule,
    );
}

export function previewPolicyPreset(
  workspacePath: string,
  presetName: string,
): {
  preset: PolicyPreset;
  state: PolicyNetworkState;
  addedRules: ManagedNetworkRule[];
} {
  const preset = loadPolicyPreset(presetName);
  const state = readPolicyState(workspacePath);
  return {
    preset,
    state,
    addedRules: collectPresetAddedRules(state, preset),
  };
}

export function applyPolicyPreset(
  workspacePath: string,
  presetName: string,
): {
  preset: PolicyPreset;
  state: PolicyNetworkState;
  addedRules: ManagedNetworkRule[];
} {
  const { preset, state, addedRules } = previewPolicyPreset(
    workspacePath,
    presetName,
  );

  const next = setPolicyPresets(workspacePath, {
    presets: [...new Set([...state.presets, preset.name])],
    rules: [
      ...state.rules.map((rule) => stripRuleIndexWithMetadata(rule)),
      ...addedRules,
    ],
  });

  return {
    preset,
    state: next,
    addedRules,
  };
}

export function removePolicyPreset(
  workspacePath: string,
  presetName: string,
): {
  preset: PolicyPreset;
  state: PolicyNetworkState;
  removedCount: number;
} {
  const preset = loadPolicyPreset(presetName);
  const state = readPolicyState(workspacePath);
  const keptRules = state.rules
    .filter((rule) => rule.managedByPreset !== preset.name)
    .map((rule) => stripRuleIndexWithMetadata(rule));
  const removedCount = state.rules.filter(
    (rule) => rule.managedByPreset === preset.name,
  ).length;
  const next = setPolicyPresets(workspacePath, {
    presets: state.presets.filter((name) => name !== preset.name),
    rules: keptRules,
  });

  return {
    preset,
    state: next,
    removedCount,
  };
}
