/**
 * Dry-run requests on the OpenAI-compatible API: which requests may run as
 * one, and removing the throwaway sessions they ran in.
 *
 * A dry run is an ordinary turn of an existing agent. Its tool calls pass the
 * agent runtime's read-only `dry_run` approval rule, and the turn pipeline
 * skips writes that would outlive the session. Usage and audit records are
 * kept. NOT the tool gate itself, and NOT ordinary session deletion
 * (`gateway-session-deletion.ts`), which also removes usage and audit.
 */
import fs from 'node:fs';
import { resolveAgentConfig } from '../agents/agent-registry.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { withMemoryDatabase } from '../memory/database.js';
import { removeSessionFiles } from './gateway-session-deletion.js';
import { OpenAICompatibleRequestError } from './openai-compatible-request.js';
import { isDecisionModel } from './openai-decision.js';

export function assertDryRunAllowed(params: {
  usesClientTools: boolean;
  model: string;
  agentId: string;
}): void {
  // Client tools, decision models and proxied agents run tools outside the
  // read-only gate.
  if (
    params.usesClientTools ||
    isDecisionModel(params.model) ||
    resolveAgentConfig(params.agentId).proxy
  ) {
    throw new OpenAICompatibleRequestError(
      400,
      'A dry run needs a turn of the agent itself, without client tools, a decision model or a proxied agent.',
      { param: 'model', code: 'unsupported_value' },
    );
  }
  // Bootstrapping an unknown agent would create it; a dry run creates nothing.
  if (!fs.existsSync(agentWorkspaceDir(params.agentId))) {
    throw new OpenAICompatibleRequestError(
      400,
      `A dry run needs an existing agent; "${params.agentId}" has no workspace.`,
      { param: 'model', code: 'unsupported_value' },
    );
  }
}

/**
 * Removes the sessions a dry-run turn ran in, by session key or row id: rows
 * and files. Usage and audit records stay, so the turn is still accounted for.
 */
export function discardDryRunSessions(
  sessionKeys: ReadonlyArray<string | undefined>,
  agentId: string,
): void {
  const keys = sessionKeys.filter((key): key is string => Boolean(key));
  const rowIds = withMemoryDatabase((db) =>
    db.transaction(() =>
      keys.flatMap((key) => {
        const rows = db
          .prepare('SELECT id FROM sessions WHERE id = ? OR session_key = ?')
          .all(key, key) as Array<{ id: string }>;
        for (const { id } of rows) {
          db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        }
        return rows.map((row) => row.id);
      }),
    )(),
  );
  for (const sessionId of new Set([...keys, ...rowIds])) {
    removeSessionFiles(sessionId, agentId, null);
  }
}
