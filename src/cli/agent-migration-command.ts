import readline from 'node:readline/promises';
import {
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
  sourceRoot?: string;
}

function sourceLabel(sourceKind: AgentMigrationSource): string {
  return sourceKind === 'openclaw' ? 'OpenClaw' : 'Hermes Agent';
}

export function printAgentMigrationUsage(
  sourceKind: AgentMigrationSource,
): void {
  const command = sourceKind === 'openclaw' ? 'claw' : 'hermes';
  const defaultSource = sourceKind === 'openclaw' ? '~/.openclaw' : '~/.hermes';
  console.log(`Usage: hybridclaw ${command} migrate [options]

Options:
  --source <path>       Override the source home directory (default: ${defaultSource})
  --dry-run             Preview the migration without writing files
  --overwrite           Replace existing HybridClaw files and config values on conflict
  --migrate-secrets     Import compatible secrets into ${sourceKind === 'openclaw' ? 'credentials.json' : 'credentials.json'}
  --yes, -y             Skip the confirmation prompt
  --help, -h            Show this help text

Examples:
  hybridclaw ${command} migrate --dry-run
  hybridclaw ${command} migrate --migrate-secrets
  hybridclaw ${command} migrate --source /tmp/${command}-home --overwrite --yes`);
}

function parseMigrationArgs(args: string[]): ParsedMigrationArgs {
  let help = false;
  let dryRun = false;
  let overwrite = false;
  let migrateSecrets = false;
  let yes = false;
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
    if (arg === '--yes' || arg === '-y') {
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
    if (arg.startsWith('--source=')) {
      sourceRoot = arg.slice('--source='.length).trim();
      if (!sourceRoot) throw new Error('Missing value for `--source`.');
      continue;
    }
    throw new Error(`Unexpected migration option: ${arg}`);
  }

  return { help, dryRun, overwrite, migrateSecrets, yes, sourceRoot };
}

async function confirmMigration(
  sourceKind: AgentMigrationSource,
  sourceRoot: string,
  dryRun: boolean,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Migration confirmation requires an interactive terminal. Re-run with `--yes` to skip the prompt.',
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        `${dryRun ? 'Preview' : 'Import'} ${sourceLabel(sourceKind)} data from ${sourceRoot}? [Y/n] `,
      )
    )
      .trim()
      .toLowerCase();
    return !answer || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function handleAgentMigrationCommand(
  sourceKind: AgentMigrationSource,
  args: string[],
): Promise<void> {
  const subcommand = (args[0] || '').trim().toLowerCase();
  if (!subcommand || isHelpRequest(args)) {
    printAgentMigrationUsage(sourceKind);
    return;
  }
  if (subcommand !== 'migrate') {
    throw new Error(
      `Unknown ${sourceKind} subcommand: ${subcommand}. Use \`hybridclaw ${sourceKind === 'openclaw' ? 'claw' : 'hermes'} migrate\`.`,
    );
  }

  const parsed = parseMigrationArgs(args.slice(1));
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

  if (!parsed.yes) {
    const confirmed = await confirmMigration(
      sourceKind,
      sourceRoot,
      parsed.dryRun,
    );
    if (!confirmed) {
      console.log('Migration cancelled.');
      return;
    }
  }

  const result = await migrateAgentHome({
    sourceKind,
    sourceRoot,
    execute: !parsed.dryRun,
    overwrite: parsed.overwrite,
    migrateSecrets: parsed.migrateSecrets,
  });

  console.log(
    `${sourceLabel(sourceKind)} migration summary: migrated=${result.summary.migrated}, skipped=${result.summary.skipped}, conflicts=${result.summary.conflict}, errors=${result.summary.error}, archived=${result.summary.archived}.`,
  );
  if (result.outputDir) {
    console.log(`Report: ${result.outputDir}`);
  }
}
