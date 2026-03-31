import fs from 'node:fs';
import readline from 'node:readline/promises';
import { runtimeConfigPath } from '../config/runtime-config.js';
import {
  type AgentMigrationResult,
  type AgentMigrationSource,
  detectAgentMigrationSourceRoot,
  migrateAgentHome,
} from '../migration/agent-home-migration.js';
import { isHelpRequest } from './help.js';

interface ParsedMigrationArgs {
  help: boolean;
  dryRun: boolean;
  overwrite: boolean;
  migrateSecrets: boolean;
  yes: boolean;
  agentId?: string;
  sourceRoot?: string;
}

type PromptDecision = 'yes' | 'no' | 'cancel';

function sourceLabel(sourceKind: AgentMigrationSource): string {
  return sourceKind === 'openclaw' ? 'OpenClaw' : 'Hermes Agent';
}

function migrationItemSourceLabel(
  item: AgentMigrationResult['items'][number],
): string {
  return item.source?.includes('.hermes') ? 'Hermes Agent' : 'OpenClaw';
}

function formatMigrationValue(value: unknown): string {
  if (value === undefined) return '[unset]';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatMigrationItem(
  item: AgentMigrationResult['items'][number],
): string {
  const sourceFiles = Array.isArray(item.details?.sourceFiles)
    ? item.details.sourceFiles.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      )
    : [];
  const sourceDirectories = Array.isArray(item.details?.sourceDirectories)
    ? item.details.sourceDirectories.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      )
    : [];
  const source = item.source || '(n/a)';
  const destination = item.destination || '(n/a)';
  const reason = item.reason ? ` (${item.reason})` : '';
  if (
    item.kind === 'config:agent' &&
    typeof item.details?.agentId === 'string' &&
    item.details.agentId.trim()
  ) {
    return `  - agent: register ${item.details.agentId.trim()}${reason}`;
  }
  if (sourceDirectories.length > 0 || sourceFiles.length > 1) {
    return [
      ...sourceFiles.map(
        (filePath) =>
          `  - workspace-file: ${filePath} -> ${destination}${reason}`,
      ),
      ...sourceDirectories.map(
        (dirPath) =>
          `  - workspace-directory: ${dirPath} -> ${destination}${reason}`,
      ),
    ].join('\n');
  }
  return `  - ${item.kind}: ${source} -> ${destination}${reason}`;
}

function formatMappedConfigSummaryLines(
  item: AgentMigrationResult['items'][number],
): string[] {
  if (!hasMappedConfigDiff(item)) return [];

  const keyMappings =
    item.details?.keyMappings &&
    typeof item.details.keyMappings === 'object' &&
    !Array.isArray(item.details.keyMappings)
      ? (item.details.keyMappings as Record<
          string,
          { source?: unknown; target?: unknown }
        >)
      : {};
  const currentRecord =
    item.details?.current &&
    typeof item.details.current === 'object' &&
    !Array.isArray(item.details.current)
      ? (item.details.current as Record<string, unknown>)
      : null;
  const incomingRecord =
    item.details?.incoming &&
    typeof item.details.incoming === 'object' &&
    !Array.isArray(item.details.incoming)
      ? (item.details.incoming as Record<string, unknown>)
      : null;

  const lines: string[] = [];

  if (currentRecord && incomingRecord) {
    for (const key of Object.keys(incomingRecord)) {
      const mapping = keyMappings[key];
      if (!mapping) continue;
      const targetLabel =
        typeof mapping.target === 'string' && mapping.target.trim()
          ? mapping.target.trim()
          : key;
      const currentValue = currentRecord[key];
      const incomingValue = incomingRecord[key];
      if (currentValue === incomingValue) continue;
      lines.push(
        `  - ${item.kind}: ${targetLabel}: ${formatMigrationValue(currentValue)} -> ${formatMigrationValue(incomingValue)}`,
      );
    }
  }

  const currentModel =
    typeof item.details?.currentModel === 'string'
      ? item.details.currentModel.trim()
      : '';
  const incomingModel =
    typeof item.details?.incomingModel === 'string'
      ? item.details.incomingModel.trim()
      : typeof item.details?.model === 'string'
        ? item.details.model.trim()
        : '';

  if (lines.length === 0 && currentModel && incomingModel) {
    const modelMapping = keyMappings.model;
    const targetLabel =
      typeof modelMapping?.target === 'string' && modelMapping.target.trim()
        ? modelMapping.target.trim()
        : 'model';
    lines.push(
      `  - ${item.kind}: ${targetLabel}: ${currentModel} -> ${incomingModel}`,
    );
  }

  return lines;
}

function formatMigrationDiff(
  item: AgentMigrationResult['items'][number],
): string {
  const lines: string[] = [];
  const keyMappings =
    item.details?.keyMappings &&
    typeof item.details.keyMappings === 'object' &&
    !Array.isArray(item.details.keyMappings)
      ? (item.details.keyMappings as Record<
          string,
          { source?: unknown; target?: unknown }
        >)
      : {};
  const currentRecord =
    item.details?.current &&
    typeof item.details.current === 'object' &&
    !Array.isArray(item.details.current)
      ? (item.details.current as Record<string, unknown>)
      : null;
  const incomingRecord =
    item.details?.incoming &&
    typeof item.details.incoming === 'object' &&
    !Array.isArray(item.details.incoming)
      ? (item.details.incoming as Record<string, unknown>)
      : null;

  const mappedKeys = Object.keys(keyMappings).filter(
    (key) => key.trim().length > 0,
  );

  if (currentRecord && incomingRecord) {
    const keys =
      mappedKeys.length > 0
        ? Object.keys(incomingRecord).filter((key) => keyMappings[key])
        : Object.keys(incomingRecord);
    for (const key of keys) {
      const currentValue = currentRecord[key];
      const incomingValue = incomingRecord[key];
      const mapping = keyMappings[key];
      const targetLabel =
        typeof mapping?.target === 'string' && mapping.target.trim()
          ? `HybridClaw ${mapping.target.trim()}`
          : key;
      const sourceLabel =
        typeof mapping?.source === 'string' && mapping.source.trim()
          ? `${migrationItemSourceLabel(item)} ${mapping.source.trim()}`
          : null;
      if (currentValue === incomingValue) continue;
      if (currentValue !== undefined) {
        lines.push(`- ${targetLabel}: ${formatMigrationValue(currentValue)}`);
      }
      if (incomingValue !== undefined) {
        lines.push(
          sourceLabel
            ? `+ ${sourceLabel} -> ${targetLabel}: ${formatMigrationValue(incomingValue)}`
            : `+ ${targetLabel}: ${formatMigrationValue(incomingValue)}`,
        );
      }
    }
  }

  const currentModel =
    typeof item.details?.currentModel === 'string'
      ? item.details.currentModel.trim()
      : '';
  const incomingModel =
    typeof item.details?.incomingModel === 'string'
      ? item.details.incomingModel.trim()
      : typeof item.details?.model === 'string'
        ? item.details.model.trim()
        : '';

  if (
    lines.length === 0 &&
    currentModel &&
    incomingModel &&
    currentModel !== incomingModel
  ) {
    const modelMapping = keyMappings.model;
    const targetLabel =
      typeof modelMapping?.target === 'string' && modelMapping.target.trim()
        ? `HybridClaw ${modelMapping.target.trim()}`
        : 'current';
    const sourceLabel =
      typeof modelMapping?.source === 'string' && modelMapping.source.trim()
        ? `${migrationItemSourceLabel(item)} ${modelMapping.source.trim()}`
        : 'incoming';
    lines.push(`- ${targetLabel}: ${currentModel}`);
    lines.push(`+ ${sourceLabel} -> ${targetLabel}: ${incomingModel}`);
  }

  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

function hasMappedConfigDiff(
  item: AgentMigrationResult['items'][number],
): boolean {
  if (item.destination !== runtimeConfigPath()) return false;
  if (!item.kind.startsWith('config:')) return false;
  const keyMappings = item.details?.keyMappings;
  if (
    !keyMappings ||
    typeof keyMappings !== 'object' ||
    Array.isArray(keyMappings) ||
    Object.keys(keyMappings).length === 0
  ) {
    return false;
  }
  return formatMigrationDiff(item).trim().length > 0;
}

function listPlannedChanges(
  result: AgentMigrationResult,
): AgentMigrationResult['items'] {
  return result.items.filter(
    (item) =>
      (item.status === 'migrated' || item.status === 'conflict') &&
      !!item.destination &&
      (item.kind.startsWith('config:')
        ? hasMappedConfigDiff(item)
        : fs.existsSync(item.destination)),
  );
}

async function promptDecision(
  question: string,
  defaultYes: boolean,
): Promise<PromptDecision> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Migration confirmation requires an interactive terminal. Re-run with `--force` to skip the prompt.',
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
    const answer = (await rl.question(`${question}${suffix}`))
      .trim()
      .toLowerCase();
    if (!answer) return defaultYes ? 'yes' : 'no';
    if (answer === '\u001b' || answer === 'esc' || answer === 'escape') {
      return 'cancel';
    }
    return answer === 'y' || answer === 'yes' ? 'yes' : 'no';
  } finally {
    rl.close();
  }
}

function printMigrationDetails(result: AgentMigrationResult): void {
  const sections: Array<{
    emoji: string;
    label: string;
    status: AgentMigrationResult['items'][number]['status'];
  }> = [
    { emoji: '✅', label: 'Migrated', status: 'migrated' },
    { emoji: '⏭️', label: 'Skipped', status: 'skipped' },
    { emoji: '⚠️', label: 'Conflicts', status: 'conflict' },
    { emoji: '❌', label: 'Errors', status: 'error' },
    { emoji: '📦', label: 'Archived', status: 'archived' },
  ];

  for (const section of sections) {
    const items = result.items.filter((item) => item.status === section.status);
    if (items.length === 0) continue;
    console.log('');
    console.log(`${section.emoji} ${section.label} (${items.length})`);
    for (const item of items) {
      const mappedSummaryLines = formatMappedConfigSummaryLines(item);
      if (mappedSummaryLines.length > 0) {
        for (const line of mappedSummaryLines) console.log(line);
        continue;
      }
      console.log(formatMigrationItem(item));
    }
  }
}

export function printAgentMigrationUsage(
  sourceKind: AgentMigrationSource,
): void {
  const command = sourceKind === 'openclaw' ? 'openclaw' : 'hermes';
  const defaultSource = sourceKind === 'openclaw' ? '~/.openclaw' : '~/.hermes';
  console.log(`Usage: hybridclaw migrate ${command} [options]

Options:
  --source <path>       Override the source home directory (default: ${defaultSource})
  --agent <id>          Import into a specific HybridClaw agent (default: main)
  --dry-run             Preview the migration without writing files
  --overwrite           Replace existing HybridClaw files and config values on conflict
  --migrate-secrets     Import compatible secrets into ${sourceKind === 'openclaw' ? 'credentials.json' : 'credentials.json'}
  --force               Assume yes and overwrite replaceable conflicts
  --help, -h            Show this help text

Examples:
  hybridclaw migrate ${command} --dry-run
  hybridclaw migrate ${command} --agent writer --dry-run
  hybridclaw migrate ${command} --migrate-secrets
  hybridclaw migrate ${command} --source /tmp/${command}-home --overwrite --force`);
}

function parseMigrationArgs(args: string[]): ParsedMigrationArgs {
  let help = false;
  let dryRun = false;
  let overwrite = false;
  let migrateSecrets = false;
  let yes = false;
  let agentId: string | undefined;
  let sourceRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = (args[index] || '').trim();
    if (!arg) continue;
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--overwrite') {
      overwrite = true;
      continue;
    }
    if (arg === '--migrate-secrets') {
      migrateSecrets = true;
      continue;
    }
    if (arg === '--force') {
      yes = true;
      continue;
    }
    if (arg === '--source') {
      const next = (args[index + 1] || '').trim();
      if (!next) throw new Error('Missing value for `--source`.');
      sourceRoot = next;
      index += 1;
      continue;
    }
    if (arg === '--agent') {
      const next = (args[index + 1] || '').trim();
      if (!next) throw new Error('Missing value for `--agent`.');
      agentId = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--source=')) {
      sourceRoot = arg.slice('--source='.length).trim();
      if (!sourceRoot) throw new Error('Missing value for `--source`.');
      continue;
    }
    if (arg.startsWith('--agent=')) {
      agentId = arg.slice('--agent='.length).trim();
      if (!agentId) throw new Error('Missing value for `--agent`.');
      continue;
    }
    throw new Error(`Unexpected migration option: ${arg}`);
  }

  return {
    help,
    dryRun,
    overwrite: overwrite || yes,
    migrateSecrets,
    yes,
    agentId,
    sourceRoot,
  };
}

async function confirmMigration(
  sourceKind: AgentMigrationSource,
  sourceRoot: string,
  agentId: string | undefined,
): Promise<PromptDecision> {
  return promptDecision(
    `Import ${sourceLabel(sourceKind)} data from ${sourceRoot} into agent ${String(agentId || '').trim() || 'main'}?`,
    true,
  );
}

async function confirmMigrationItem(
  item: AgentMigrationResult['items'][number],
): Promise<PromptDecision> {
  return promptDecision(
    `Apply change?\n${formatMigrationItem(item).trimStart()}${formatMigrationDiff(item)}`,
    false,
  );
}

export async function handleAgentMigrationCommand(
  sourceKind: AgentMigrationSource,
  args: string[],
): Promise<void> {
  const normalizedArgs =
    (args[0] || '').trim().toLowerCase() === 'migrate' ? args.slice(1) : args;
  if (normalizedArgs.length === 0 || isHelpRequest(normalizedArgs)) {
    printAgentMigrationUsage(sourceKind);
    return;
  }

  const parsed = parseMigrationArgs(normalizedArgs);
  if (parsed.help) {
    printAgentMigrationUsage(sourceKind);
    return;
  }

  const sourceRoot =
    parsed.sourceRoot || detectAgentMigrationSourceRoot(sourceKind);
  if (!sourceRoot) {
    throw new Error(
      `No ${sourceLabel(sourceKind)} home was found. Use \`--source <path>\` to point at one explicitly.`,
    );
  }

  let previewResult: AgentMigrationResult | null = null;
  if (!parsed.yes) {
    previewResult = await migrateAgentHome({
      sourceKind,
      sourceRoot,
      agentId: parsed.agentId,
      execute: false,
      overwrite: parsed.overwrite,
      migrateSecrets: parsed.migrateSecrets,
    });
  }

  if (!parsed.yes && !parsed.dryRun) {
    const decision = await confirmMigration(
      sourceKind,
      sourceRoot,
      parsed.agentId,
    );
    if (decision !== 'yes') {
      console.log('Migration cancelled.');
      return;
    }
  }

  if (!parsed.yes) {
    const plannedChanges = listPlannedChanges(
      previewResult ||
        (await migrateAgentHome({
          sourceKind,
          sourceRoot,
          agentId: parsed.agentId,
          execute: false,
          overwrite: parsed.overwrite,
          migrateSecrets: parsed.migrateSecrets,
        })),
    );
    for (const item of plannedChanges) {
      const decision = await confirmMigrationItem(item);
      if (decision === 'yes') {
        continue;
      }
      if (parsed.dryRun && decision === 'no') {
        continue;
      }
      if (decision === 'cancel') {
        console.log(
          parsed.dryRun ? 'Dry run cancelled.' : 'Migration cancelled.',
        );
        return;
      }
      console.log(
        parsed.dryRun ? 'Dry run cancelled.' : 'Migration cancelled.',
      );
      return;
    }
  }

  const result =
    parsed.dryRun && previewResult
      ? previewResult
      : await migrateAgentHome({
          sourceKind,
          sourceRoot,
          agentId: parsed.agentId,
          execute: !parsed.dryRun,
          overwrite: parsed.overwrite,
          migrateSecrets: parsed.migrateSecrets,
        });

  console.log(
    `${sourceLabel(sourceKind)} migration summary for agent ${result.targetAgentId}: migrated=${result.summary.migrated}, skipped=${result.summary.skipped}, conflicts=${result.summary.conflict}, errors=${result.summary.error}, archived=${result.summary.archived}.`,
  );
  printMigrationDetails(result);
  if (result.outputDir) {
    console.log(`Report: ${result.outputDir}`);
  }
}
