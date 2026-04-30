import { getExecutorSessionHealthSnapshots } from '../agent/executor.js';
import { listAgents } from '../agents/agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  getAllSessions,
  getRecentStructuredAuditForSession,
  getSkillObservations,
} from '../memory/db.js';
import type { SkillObservation } from '../skills/adaptive-skills-types.js';
import type { Session } from '../types/session.js';
import { getFullAutoRuntimeState } from './fullauto-runtime.js';
import { parseTimestampMs } from './gateway-time.js';
import type {
  GatewayCoworkerLivenessCheck,
  GatewayCoworkerLivenessProbe,
  GatewayCoworkerLivenessState,
  GatewayCoworkerLivenessSummary,
} from './gateway-types.js';

const RECENT_SUCCESSFUL_SKILL_RUN_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_ESCALATING_ERROR_MS = 2 * 60 * 60 * 1000;
const ESCALATING_ERROR_COUNT = 3;

type Check = GatewayCoworkerLivenessCheck;

function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => (value || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function newestTimestamp(
  values: Iterable<string | null | undefined>,
): string | null {
  let newest: string | null = null;
  let newestMs = 0;
  for (const value of values) {
    const timestamp = (value || '').trim();
    const ms = parseTimestampMs(timestamp);
    if (ms > newestMs) {
      newest = timestamp;
      newestMs = ms;
    }
  }
  return newest;
}

function buildProcessCheck(params: {
  activeSessions: number;
  responsiveSessions: number;
  busySessions: number;
  terminalErrors: string[];
  healthErrors: string[];
  lastObservedAt: string | null;
}): GatewayCoworkerLivenessProbe['process'] {
  if (params.terminalErrors.length > 0) {
    return {
      ok: false,
      code: 'process_terminal_error',
      detail: params.terminalErrors[0] || 'runtime reported a terminal error',
      observedAt: params.lastObservedAt,
      activeSessions: params.activeSessions,
      responsiveSessions: params.responsiveSessions,
      busySessions: params.busySessions,
    };
  }
  if (
    params.activeSessions > 0 &&
    params.responsiveSessions < params.activeSessions
  ) {
    return {
      ok: false,
      code: 'process_unresponsive',
      detail:
        params.healthErrors[0] ||
        'active runtime process is not accepting work',
      observedAt: params.lastObservedAt,
      activeSessions: params.activeSessions,
      responsiveSessions: params.responsiveSessions,
      busySessions: params.busySessions,
    };
  }
  if (params.activeSessions > 0 && params.busySessions > 0) {
    return {
      ok: true,
      code: 'process_busy',
      detail: `${params.busySessions}/${params.activeSessions} active runtime session(s) currently processing work`,
      observedAt: params.lastObservedAt,
      activeSessions: params.activeSessions,
      responsiveSessions: params.responsiveSessions,
      busySessions: params.busySessions,
    };
  }
  if (params.activeSessions > 0) {
    return {
      ok: true,
      code: 'process_responsive',
      detail: `${params.responsiveSessions}/${params.activeSessions} active runtime session(s) responsive`,
      observedAt: params.lastObservedAt,
      activeSessions: params.activeSessions,
      responsiveSessions: params.responsiveSessions,
      busySessions: params.busySessions,
    };
  }
  return {
    ok: true,
    code: 'process_not_running',
    detail: 'no active runtime process is attached',
    observedAt: params.lastObservedAt,
    activeSessions: 0,
    responsiveSessions: 0,
    busySessions: 0,
  };
}

function buildRecentSkillRunCheck(
  runs: SkillObservation[],
  now: number,
): GatewayCoworkerLivenessProbe['recentSkillRun'] {
  if (runs.length === 0) {
    return {
      ok: false,
      code: 'no_skill_runs_observed',
      detail: 'no skill execution observations found for this coworker',
      observedAt: null,
      skillName: null,
      outcome: null,
    };
  }

  const latestSuccess = runs.find((run) => run.outcome === 'success');
  if (!latestSuccess) {
    const latest = runs[0];
    return {
      ok: false,
      code: 'no_successful_skill_run',
      detail: 'skill observations exist, but none succeeded',
      observedAt: latest?.created_at || null,
      skillName: latest?.skill_name || null,
      outcome: latest?.outcome || null,
    };
  }

  const successAtMs = parseTimestampMs(latestSuccess.created_at);
  const recent =
    successAtMs > 0 && now - successAtMs <= RECENT_SUCCESSFUL_SKILL_RUN_MS;
  return {
    ok: recent,
    code: recent ? 'recent_successful_skill_run' : 'stale_successful_skill_run',
    detail: recent
      ? `last successful skill run was ${latestSuccess.skill_name}`
      : `last successful skill run is older than ${Math.floor(
          RECENT_SUCCESSFUL_SKILL_RUN_MS / 86_400_000,
        )} days`,
    observedAt: latestSuccess.created_at,
    skillName: latestSuccess.skill_name,
    outcome: latestSuccess.outcome,
  };
}

function countLeadingRecentSkillFailures(
  runs: SkillObservation[],
  now: number,
): number {
  let count = 0;
  for (const run of runs) {
    if (run.outcome === 'success') break;
    const createdAtMs = parseTimestampMs(run.created_at);
    if (createdAtMs <= 0 || now - createdAtMs > RECENT_ESCALATING_ERROR_MS) {
      break;
    }
    count += 1;
  }
  return count;
}

function countRecentAuditErrors(sessions: Session[], now: number): number {
  let count = 0;
  for (const session of sessions.slice(0, 8)) {
    const rows = getRecentStructuredAuditForSession(session.id, 20);
    for (const row of rows) {
      if (row.event_type !== 'error') continue;
      const timestampMs = parseTimestampMs(row.timestamp || row.created_at);
      if (timestampMs > 0 && now - timestampMs <= RECENT_ESCALATING_ERROR_MS) {
        count += 1;
      }
    }
  }
  return count;
}

function buildEscalatingErrorsCheck(params: {
  sessions: Session[];
  skillRuns: SkillObservation[];
  now: number;
}): GatewayCoworkerLivenessProbe['escalatingErrors'] {
  const recentSkillFailures = countLeadingRecentSkillFailures(
    params.skillRuns,
    params.now,
  );
  if (recentSkillFailures >= ESCALATING_ERROR_COUNT) {
    return {
      ok: false,
      code: 'recent_skill_failures_escalating',
      detail: `${recentSkillFailures} recent skill run failure(s) without a success`,
      observedAt: params.skillRuns[0]?.created_at || null,
      count: recentSkillFailures,
    };
  }

  for (const session of params.sessions) {
    const state = getFullAutoRuntimeState(session.id);
    const consecutiveErrors = state?.consecutiveErrors ?? 0;
    if (consecutiveErrors >= ESCALATING_ERROR_COUNT) {
      return {
        ok: false,
        code: 'fullauto_errors_escalating',
        detail: `${consecutiveErrors} consecutive full-auto error(s)`,
        observedAt: session.last_active,
        count: consecutiveErrors,
      };
    }
  }

  const auditErrors = countRecentAuditErrors(params.sessions, params.now);
  if (auditErrors >= ESCALATING_ERROR_COUNT) {
    return {
      ok: false,
      code: 'recent_turn_errors_escalating',
      detail: `${auditErrors} recent agent error event(s)`,
      observedAt: newestTimestamp(params.sessions.map((s) => s.last_active)),
      count: auditErrors,
    };
  }

  return {
    ok: true,
    code: 'no_escalating_errors',
    detail: 'no escalating error pattern detected',
    observedAt: newestTimestamp(params.sessions.map((s) => s.last_active)),
    count: 0,
  };
}

function deriveState(params: {
  process: Check;
  recentSkillRun: Check;
  escalatingErrors: Check;
}): GatewayCoworkerLivenessState {
  if (!params.process.ok || !params.escalatingErrors.ok) return 'red';
  if (!params.recentSkillRun.ok) return 'amber';
  return 'green';
}

function deriveReasonCodes(params: {
  state: GatewayCoworkerLivenessState;
  process: Check;
  recentSkillRun: Check;
  escalatingErrors: Check;
}): string[] {
  const failed = [
    params.process,
    params.recentSkillRun,
    params.escalatingErrors,
  ]
    .filter((check) => !check.ok)
    .map((check) => check.code);
  if (failed.length > 0) return failed;
  return params.state === 'green' ? ['all_checks_passing'] : [];
}

function buildProbe(params: {
  agentId: string;
  sessions: Session[];
  executorSnapshots: Awaited<
    ReturnType<typeof getExecutorSessionHealthSnapshots>
  >;
  checkedAt: string;
  now: number;
}): GatewayCoworkerLivenessProbe {
  const executorSnapshots = params.executorSnapshots.filter(
    (snapshot) => snapshot.agentId === params.agentId,
  );
  const skillRuns = getSkillObservations({
    agentId: params.agentId,
    limit: 50,
  });
  const process = buildProcessCheck({
    activeSessions: executorSnapshots.length,
    responsiveSessions: executorSnapshots.filter(
      (snapshot) => snapshot.responsive,
    ).length,
    busySessions: executorSnapshots.filter((snapshot) => snapshot.busy).length,
    terminalErrors: executorSnapshots
      .map((snapshot) => snapshot.terminalError)
      .filter((value): value is string => Boolean(value)),
    healthErrors: executorSnapshots
      .map((snapshot) => snapshot.healthError)
      .filter((value): value is string => Boolean(value)),
    lastObservedAt: newestTimestamp(
      executorSnapshots.map((snapshot) =>
        snapshot.lastUsedAt > 0
          ? new Date(snapshot.lastUsedAt).toISOString()
          : null,
      ),
    ),
  });
  const recentSkillRun = buildRecentSkillRunCheck(skillRuns, params.now);
  const escalatingErrors = buildEscalatingErrorsCheck({
    sessions: params.sessions,
    skillRuns,
    now: params.now,
  });
  const state = deriveState({ process, recentSkillRun, escalatingErrors });

  return {
    agentId: params.agentId,
    state,
    reasonCodes: deriveReasonCodes({
      state,
      process,
      recentSkillRun,
      escalatingErrors,
    }),
    checkedAt: params.checkedAt,
    process,
    recentSkillRun,
    escalatingErrors,
  };
}

export async function getCoworkerLivenessSummary(params?: {
  agentIds?: readonly string[];
}): Promise<GatewayCoworkerLivenessSummary> {
  const checkedAt = new Date().toISOString();
  const now = Date.now();
  const sessions = getAllSessions({
    limit: 1_000,
    warnLabel: 'coworker-liveness',
  });
  const configuredAgents = listAgents() as AgentConfig[];
  const requestedIds = params?.agentIds ? [...params.agentIds] : [];
  const executorSnapshots = await getExecutorSessionHealthSnapshots();
  const agentIds = uniqueStrings([
    DEFAULT_AGENT_ID,
    ...configuredAgents.map((agent) => agent.id),
    ...sessions.map((session) => session.agent_id),
    ...executorSnapshots.map((snapshot) => snapshot.agentId),
    ...requestedIds,
  ]);
  const sessionsByAgent = new Map<string, Session[]>();
  for (const session of sessions) {
    const agentId = (session.agent_id || DEFAULT_AGENT_ID).trim();
    const existing = sessionsByAgent.get(agentId) ?? [];
    existing.push(session);
    sessionsByAgent.set(agentId, existing);
  }

  const probes = agentIds.map((agentId) =>
    buildProbe({
      agentId,
      sessions: sessionsByAgent.get(agentId) ?? [],
      executorSnapshots,
      checkedAt,
      now,
    }),
  );
  const totals: Record<GatewayCoworkerLivenessState, number> = {
    green: 0,
    amber: 0,
    red: 0,
  };
  for (const probe of probes) {
    totals[probe.state] += 1;
  }
  return {
    checkedAt,
    totals,
    probes,
  };
}

export function formatCoworkerLivenessPage(
  probe: GatewayCoworkerLivenessProbe,
): string {
  return [
    `Coworker liveness ${probe.state.toUpperCase()}: ${probe.agentId}`,
    `Reasons: ${probe.reasonCodes.join(', ')}`,
    `Process: ${probe.process.code} - ${probe.process.detail}`,
    `Skill: ${probe.recentSkillRun.code} - ${probe.recentSkillRun.detail}`,
    `Errors: ${probe.escalatingErrors.code} - ${probe.escalatingErrors.detail}`,
  ].join('\n');
}
