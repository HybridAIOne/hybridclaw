import {
  beginInstructionApprovalAudit,
  completeInstructionApprovalAudit,
} from '../security/instruction-approval-audit.js';
import {
  INSTRUCTION_FILES,
  summarizeInstructionIntegrity,
  syncRuntimeInstructionCopies,
  verifyInstructionIntegrity,
} from '../security/instruction-integrity.js';

const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

type DbModule = typeof import('../memory/db.js');

let cachedDbModule: DbModule | null = null;

function parseLimit(
  raw: string | undefined,
  fallback: number,
  max = 200,
): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function red(text: string): string {
  if (!process.stdout.isTTY) return text;
  return `${ANSI_RED}${text}${ANSI_RESET}`;
}

function parsePayload(payloadRaw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payloadRaw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isDeniedStructuredEvent(
  eventType: string,
  payloadRaw: string,
): boolean {
  const payload = parsePayload(payloadRaw);
  if (!payload) return false;

  if (eventType === 'approval.response') {
    return payload.approved === false;
  }
  if (eventType === 'authorization.check') {
    return payload.allowed === false;
  }
  return false;
}

function printUsage(): void {
  console.log(`Usage: hybridclaw audit <command>

Commands:
  recent [n]                         Show recent structured audit entries
  recent session <sessionId> [n]     Show recent events for one session
  search <query> [n]                 Search structured audit events
  approvals [n] [--denied]           Show approval decisions
  verify <sessionId>                 Verify wire hash chain integrity
  scan-leaks [sessionId] [--json]    Scan audit logs for leaked confidential info
  instructions [--sync] [--approve]  Verify or restore runtime instruction files`);
}

function runInstructionHashesCommand(args: string[]): void {
  const sync = args.includes('--sync') || args.includes('--approve');
  const unknownArgs = args.filter(
    (arg) => arg !== '--sync' && arg !== '--approve',
  );
  if (unknownArgs.length > 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log('Instruction runtime/source integrity check');

  if (sync) {
    const verifyBefore = verifyInstructionIntegrity();
    const auditContext = beginInstructionApprovalAudit({
      sessionId: 'cli:audit',
      source: 'audit.instructions',
      description: `CLI instruction sync requested (${summarizeInstructionIntegrity(verifyBefore)}).`,
    });

    try {
      const synced = syncRuntimeInstructionCopies();
      for (const relPath of INSTRUCTION_FILES) {
        console.log(`synced    ${relPath} ${synced.files[relPath]}`);
      }
      console.log(
        `Restored runtime instruction files at ${synced.runtimeRoot} (${synced.syncedAt}).`,
      );
      completeInstructionApprovalAudit({
        context: auditContext,
        approved: true,
        approvedBy: 'local-user',
        method: 'cli',
        description: `CLI instruction sync committed (${synced.syncedAt}).`,
      });
    } catch (err) {
      process.exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      console.log(red(message));
      completeInstructionApprovalAudit({
        context: auditContext,
        approved: false,
        approvedBy: 'local-user',
        method: 'cli',
        description: `CLI instruction sync failed (${message}).`,
      });
    }
    return;
  }

  const result = verifyInstructionIntegrity();

  for (const file of result.files) {
    if (file.status === 'ok') {
      console.log(`ok        ${file.path} ${file.actualHash}`);
      continue;
    }

    if (file.status === 'source_missing') {
      console.log(red(`source-missing ${file.path}`));
      console.log(`  source   ${file.sourcePath}`);
      console.log(`  runtime  ${file.runtimePath}`);
      console.log('  expected <missing source>');
      console.log(`  actual   ${file.actualHash || '<missing>'}`);
      continue;
    }

    if (file.status === 'missing') {
      console.log(red(`missing   ${file.path}`));
      console.log(`  source   ${file.sourcePath}`);
      console.log(`  runtime  ${file.runtimePath}`);
      console.log(`  expected ${file.expectedHash}`);
      console.log('  actual   <missing>');
      continue;
    }

    console.log(red(`modified  ${file.path}`));
    console.log(`  source   ${file.sourcePath}`);
    console.log(`  runtime  ${file.runtimePath}`);
    console.log(`  expected ${file.expectedHash}`);
    console.log(`  actual   ${file.actualHash}`);
  }

  if (!result.ok) {
    process.exitCode = 1;
    console.log(
      'Run `hybridclaw audit instructions --sync` to restore runtime copies from installed sources.',
    );
    return;
  }

  console.log('Runtime instruction files match installed sources.');
}

function summarizePayload(payloadRaw: string): string {
  try {
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    if (payload.type === 'tool.result') {
      const status = payload.isError ? 'error' : 'ok';
      return `${String(payload.toolName || 'tool')} ${status} ${String(payload.durationMs || 0)}ms`;
    }
    return JSON.stringify(payload).slice(0, 140);
  } catch {
    return payloadRaw.slice(0, 140);
  }
}

async function getDbModule(): Promise<DbModule> {
  if (cachedDbModule) return cachedDbModule;
  cachedDbModule = await import('../memory/db.js');
  cachedDbModule.initDatabase({ quiet: true });
  return cachedDbModule;
}

export async function runAuditCli(rawArgs: string[]): Promise<void> {
  const args = [...rawArgs];
  const cmd = (args.shift() || '').toLowerCase();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  if (cmd === 'instructions') {
    runInstructionHashesCommand(args);
    return;
  }

  if (cmd === 'scan-leaks') {
    const { runLeakScanCli } = await import('./leak-scanner-cli.js');
    await runLeakScanCli(args);
    return;
  }

  if (cmd === 'verify') {
    const sessionId = args[0];
    if (!sessionId) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const { verifyAuditSessionChain } = await import('./audit-trail.js');
    const result = verifyAuditSessionChain(sessionId);
    if (result.ok) {
      console.log(
        `✓ ${result.checkedRecords} records verified for ${sessionId} (last seq ${result.lastSeq}).`,
      );
      return;
    }
    console.error(`Audit verification failed for ${sessionId}`);
    for (const line of result.errors.slice(0, 10)) {
      console.error(`- ${line}`);
    }
    process.exitCode = 1;
    return;
  }

  if (cmd === 'search') {
    const numericLast =
      args.length > 1 && /^\d+$/.test(args[args.length - 1] || '');
    const limit = numericLast ? parseLimit(args.pop(), 25) : 25;
    const query = args.join(' ').trim();
    if (!query) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const { searchStructuredAudit } = await getDbModule();
    const rows = searchStructuredAudit(query, limit);
    if (rows.length === 0) {
      console.log('No matching audit events.');
      return;
    }
    rows.forEach((row) => {
      const line = `${row.session_id} #${row.seq} ${row.event_type} ${row.timestamp} ${summarizePayload(row.payload)}`;
      console.log(
        isDeniedStructuredEvent(row.event_type, row.payload) ? red(line) : line,
      );
    });
    return;
  }

  if (cmd === 'approvals') {
    const deniedOnly = args.includes('--denied');
    const numeric = args.find((arg) => /^\d+$/.test(arg));
    const limit = parseLimit(numeric, 20);
    const { getRecentApprovals } = await getDbModule();
    const rows = getRecentApprovals(limit, deniedOnly);
    if (rows.length === 0) {
      console.log('No approval audit entries.');
      return;
    }
    rows.forEach((row) => {
      const verdict = row.approved ? 'approved' : 'denied';
      const line = `${row.timestamp} ${verdict} ${row.action} (${row.method}) [${row.tool_call_id}]`;
      console.log(row.approved ? line : red(line));
    });
    return;
  }

  if (cmd === 'recent') {
    if (args[0] === 'session') {
      const sessionId = args[1];
      if (!sessionId) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const limit = parseLimit(args[2], 20);
      const { getRecentStructuredAuditForSession } = await getDbModule();
      const rows = getRecentStructuredAuditForSession(sessionId, limit);
      if (rows.length === 0) {
        console.log('No structured audit events for that session.');
        return;
      }
      rows.forEach((row) => {
        const line = `#${row.seq} ${row.event_type} ${row.timestamp} ${summarizePayload(row.payload)}`;
        console.log(
          isDeniedStructuredEvent(row.event_type, row.payload)
            ? red(line)
            : line,
        );
      });
      return;
    }

    const numeric = args.find((arg) => /^\d+$/.test(arg));
    const limit = parseLimit(numeric, 20);
    const { getRecentStructuredAudit } = await getDbModule();
    const rows = getRecentStructuredAudit(limit);
    if (rows.length === 0) {
      console.log('No structured audit entries.');
      return;
    }
    rows.forEach((row) => {
      const line = `${row.session_id} #${row.seq} ${row.event_type} ${row.timestamp} ${summarizePayload(row.payload)}`;
      console.log(
        isDeniedStructuredEvent(row.event_type, row.payload) ? red(line) : line,
      );
    });
    return;
  }

  printUsage();
  process.exitCode = 1;
}
