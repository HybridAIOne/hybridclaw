import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  createHarnessEvolutionSpreadsheetExample,
  createHarnessEvolutionStarterSuites,
  createHarnessEvolutionSuites,
  fetchHarnessEvolutionManifest,
  fetchHarnessEvolutionRun,
  fetchHarnessEvolutionRuns,
  initializeHarnessEvolutionTarget,
  startHarnessEvolutionRun,
} from '../api/client';
import type {
  AdminHarnessEvolutionManifestEntry,
  AdminHarnessEvolutionRound,
  AdminHarnessEvolutionRunListEntry,
  AdminHarnessEvolutionRunPayload,
  AdminHarnessEvolutionStarterSuites,
  AdminHarnessEvolutionSuiteBuilderPayload,
} from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { MetricCard, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

const METRIC_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});

const DEFAULT_TARGET_ROOT = '~/.hybridclaw/data/harness-evolution/demo-agent';

const DEFAULT_SETTINGS = {
  targetRoot: DEFAULT_TARGET_ROOT,
  suitePath: '',
  selectionSuitePath: '',
  rounds: '3',
  rolloutsPerTask: '1',
  maxEditsPerRound: '4',
  freshSeed: true,
  dryRun: false,
  commit: false,
};

type HarnessEvolutionSettings = typeof DEFAULT_SETTINGS;

const DEFAULT_SUITE_BUILDER = {
  suiteName: 'Harness eval',
  costBudgetUsd: '0.05',
  trainCommands: '',
  selectionCommands: '',
};

type HarnessEvolutionSuiteBuilder = typeof DEFAULT_SUITE_BUILDER;

function parseOptionalPositiveInteger(
  value: string,
  label: string,
): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
}

function buildRunPayload(
  settings: HarnessEvolutionSettings,
): AdminHarnessEvolutionRunPayload {
  const targetRoot = settings.targetRoot.trim();
  const suitePath = settings.suitePath.trim();
  if (!targetRoot) throw new Error('Target workspace is required.');
  if (!suitePath) {
    throw new Error(
      'Train suite path is required. Click Create starter suites to generate one in the target workspace.',
    );
  }
  return {
    targetRoot,
    suitePath,
    selectionSuitePath: settings.selectionSuitePath.trim() || undefined,
    rounds: parseOptionalPositiveInteger(settings.rounds, 'Rounds'),
    rolloutsPerTask: parseOptionalPositiveInteger(
      settings.rolloutsPerTask,
      'Rollouts per task',
    ),
    maxEditsPerRound: parseOptionalPositiveInteger(
      settings.maxEditsPerRound,
      'Max edits per round',
    ),
    freshSeed: settings.freshSeed,
    dryRun: settings.dryRun,
    commit: settings.commit,
  };
}

function parseOptionalUsd(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Cost budget must be a non-negative number.');
  }
  return parsed;
}

function parseSuiteCommandRows(text: string, split: 'train' | 'selection') {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      const named = line.match(/^([A-Za-z0-9._-]+)\s*:\s+(.+)$/u);
      const id = named?.[1] || `${split}-${index + 1}`;
      const command = named?.[2] || line;
      return { id, command, split };
    });
}

function buildSuiteBuilderPayload(
  settings: HarnessEvolutionSettings,
  builder: HarnessEvolutionSuiteBuilder,
): AdminHarnessEvolutionSuiteBuilderPayload {
  const targetRoot = settings.targetRoot.trim();
  if (!targetRoot) throw new Error('Target workspace is required.');
  const trainTasks = parseSuiteCommandRows(builder.trainCommands, 'train');
  const selectionTasks = parseSuiteCommandRows(
    builder.selectionCommands,
    'selection',
  );
  if (trainTasks.length === 0) {
    throw new Error('Add at least one train command.');
  }
  if (selectionTasks.length === 0) {
    throw new Error('Add at least one selection command.');
  }
  return {
    targetRoot,
    suiteName: builder.suiteName.trim() || undefined,
    costBudgetUsd: parseOptionalUsd(builder.costBudgetUsd),
    tasks: [...trainTasks, ...selectionTasks],
  };
}

function formatDecimal(value: number): string {
  return METRIC_NUMBER_FORMATTER.format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatSurface(surface: string): string {
  return surface.replaceAll('_', ' ');
}

function formatEditSource(
  source: AdminHarnessEvolutionRound['evolveAgent']['source'],
) {
  if (source === 'evolve_agent') return 'optimizer';
  if (source === 'report_json') return 'report';
  if (source === 'provided_edits') return 'provided';
  return 'skipped';
}

function formatGate(round: AdminHarnessEvolutionRound): string {
  if (!round.selectionGate) return 'not recorded';
  if (round.selectionGate.mode === 'dry_run') return 'dry run';
  return round.selectionGate.accepted ? 'accepted' : 'rejected';
}

function surfaceEdits(round: AdminHarnessEvolutionRound): string {
  const edits = Object.entries(round.editsPerSurface)
    .filter(([, count]) => count > 0)
    .map(([surface, count]) => `${formatSurface(surface)}: ${count}`)
    .join(', ');
  return edits || 'none';
}

function gatedPassAt1(round: AdminHarnessEvolutionRound): number {
  return round.selectionGate?.candidatePassAt1 ?? round.metrics.passAt1;
}

function trajectoryPoints(rounds: AdminHarnessEvolutionRound[]): string {
  if (rounds.length === 0) return '';
  const width = 320;
  const height = 96;
  const padding = 12;
  const span = Math.max(1, rounds.length - 1);
  return rounds
    .map((round, index) => {
      const x = padding + (index / span) * (width - padding * 2);
      const y =
        height -
        padding -
        Math.max(0, Math.min(1, gatedPassAt1(round))) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function TrajectoryChart({ rounds }: { rounds: AdminHarnessEvolutionRound[] }) {
  const points = trajectoryPoints(rounds);
  if (!points) return <div className="empty-state">No trajectory yet.</div>;
  return (
    <svg
      aria-label="gated first-try pass rate trajectory"
      role="img"
      viewBox="0 0 320 96"
      style={{ width: '100%', height: 120, marginBottom: 16 }}
    >
      <title>Gated first-try pass rate trajectory</title>
      <line x1="12" y1="84" x2="308" y2="84" stroke="var(--border)" />
      <line x1="12" y1="12" x2="12" y2="84" stroke="var(--border)" />
      <polyline
        fill="none"
        points={points}
        stroke="var(--accent)"
        strokeWidth="2.5"
      />
      {points.split(' ').map((point, index) => {
        const [x, y] = point.split(',');
        return (
          <circle
            cx={x}
            cy={y}
            fill="var(--accent)"
            key={`${rounds[index]?.round}-${point}`}
            r="3"
          />
        );
      })}
    </svg>
  );
}

function SkillOptStagePipeline({
  round,
}: {
  round: AdminHarnessEvolutionRound | null;
}) {
  if (!round) return <div className="empty-state">No round stages yet.</div>;
  const stages = round.stages;
  const gateStatus = formatGate(round);
  const items = [
    {
      label: 'Rollout',
      value: stages
        ? `${stages.rollout.rolloutCount} rollouts`
        : `${round.metrics.rolloutCount} rollouts`,
      detail: stages
        ? `${stages.rollout.taskCount} train tasks`
        : `${round.metrics.taskCount} train tasks`,
    },
    {
      label: 'Reflect',
      value: stages
        ? `${stages.reflect.failureCount} failures`
        : `${round.metrics.rolloutCount - round.metrics.successCount} failures`,
      detail: round.reportPath,
    },
    {
      label: 'Aggregate + Select',
      value: stages
        ? `${stages.aggregateSelect.selectedEditCount}/${stages.aggregateSelect.proposedEditCount} edits`
        : `${round.evolveAgent.editCount} edits`,
      detail: stages
        ? `max ${stages.aggregateSelect.maxEdits}`
        : formatEditSource(round.evolveAgent.source),
    },
    {
      label: 'Update',
      value: stages?.update.status || 'recorded',
      detail: `${stages?.update.appliedEditCount ?? round.evolveAgent.editCount} applied edits`,
    },
    {
      label: 'Gate',
      value: gateStatus,
      detail: `selection ${formatPercent(gatedPassAt1(round))}`,
    },
    {
      label: 'Memory',
      value: stages
        ? `${stages.memory.rejectedEditCount} rejected`
        : `${round.selectionGate?.rejectedEditCount || 0} rejected`,
      detail: stages?.memory.optimizerMemoryPath || 'optimizer memory',
    },
  ];
  return (
    <ul className="harness-stage-grid" aria-label="SkillOpt stages">
      {items.map((item) => (
        <li className="harness-stage-item" key={item.label}>
          <strong>{item.label}</strong>
          <span>{item.value}</span>
          <small>{item.detail}</small>
        </li>
      ))}
    </ul>
  );
}

export function HarnessEvolutionPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [settings, setSettings] =
    useState<HarnessEvolutionSettings>(DEFAULT_SETTINGS);
  const [suiteBuilder, setSuiteBuilder] =
    useState<HarnessEvolutionSuiteBuilder>(DEFAULT_SUITE_BUILDER);
  const [submittedTargetRoot, setSubmittedTargetRoot] = useState('');
  const [selectedRun, setSelectedRun] =
    useState<AdminHarnessEvolutionRunListEntry | null>(null);
  const [selectedManifestPath, setSelectedManifestPath] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ['harness-evolution-runs', auth.token, submittedTargetRoot],
    queryFn: () => fetchHarnessEvolutionRuns(auth.token, submittedTargetRoot),
    enabled: Boolean(submittedTargetRoot),
  });

  const effectiveRun = selectedRun || runsQuery.data?.runs[0] || null;
  const runQuery = useQuery({
    queryKey: [
      'harness-evolution-run',
      auth.token,
      submittedTargetRoot,
      effectiveRun?.summaryPath,
    ],
    queryFn: () =>
      fetchHarnessEvolutionRun(
        auth.token,
        submittedTargetRoot,
        effectiveRun?.summaryPath || '',
      ),
    enabled: Boolean(submittedTargetRoot && effectiveRun?.summaryPath),
  });

  const effectiveManifestPath =
    selectedManifestPath || runQuery.data?.run.rounds[0]?.manifestPath || '';
  const manifestQuery = useQuery({
    queryKey: [
      'harness-evolution-manifest',
      auth.token,
      submittedTargetRoot,
      effectiveManifestPath,
    ],
    queryFn: () =>
      fetchHarnessEvolutionManifest(
        auth.token,
        submittedTargetRoot,
        effectiveManifestPath,
      ),
    enabled: Boolean(submittedTargetRoot && effectiveManifestPath),
  });

  const latestRun = runQuery.data?.run;
  const manifestEntries = manifestQuery.data?.manifest.entries || [];
  const totalRollouts = useMemo(
    () =>
      latestRun?.rounds.reduce(
        (total, round) => total + round.metrics.rolloutCount,
        0,
      ) || 0,
    [latestRun],
  );
  const acceptedCandidates = useMemo(
    () =>
      latestRun?.rounds.filter((round) => round.selectionGate?.accepted)
        .length || 0,
    [latestRun],
  );
  const latestRound =
    latestRun && latestRun.rounds.length > 0
      ? latestRun.rounds[latestRun.rounds.length - 1]
      : null;

  const refreshRuns = async (targetRoot: string) => {
    await queryClient.invalidateQueries({
      queryKey: ['harness-evolution-runs', auth.token, targetRoot],
    });
  };

  const applyStarterSuites = (
    starterSuites: AdminHarnessEvolutionStarterSuites,
  ) => {
    setSettings((current) => ({
      ...current,
      suitePath: starterSuites.trainSuitePath,
      selectionSuitePath: starterSuites.selectionSuitePath,
    }));
  };

  const initMutation = useMutation({
    mutationFn: (targetRoot: string) =>
      initializeHarnessEvolutionTarget(auth.token, targetRoot),
    onSuccess: async (response) => {
      setFormError(null);
      setSelectedRun(null);
      setSelectedManifestPath('');
      setSubmittedTargetRoot(response.targetRoot);
      if (response.starterSuites) applyStarterSuites(response.starterSuites);
      setSettings((current) => ({
        ...current,
        targetRoot: response.targetRoot,
      }));
      await refreshRuns(response.targetRoot);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  const starterSuitesMutation = useMutation({
    mutationFn: (targetRoot: string) =>
      createHarnessEvolutionStarterSuites(auth.token, targetRoot),
    onSuccess: async (response) => {
      setFormError(null);
      setSelectedRun(null);
      setSelectedManifestPath('');
      setSubmittedTargetRoot(response.targetRoot);
      applyStarterSuites(response.starterSuites);
      setSettings((current) => ({
        ...current,
        targetRoot: response.targetRoot,
      }));
      await refreshRuns(response.targetRoot);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  const spreadsheetExampleMutation = useMutation({
    mutationFn: (targetRoot: string) =>
      createHarnessEvolutionSpreadsheetExample(auth.token, targetRoot),
    onSuccess: async (response) => {
      setFormError(null);
      setSelectedRun(null);
      setSelectedManifestPath('');
      setSubmittedTargetRoot(response.targetRoot);
      applyStarterSuites(response.starterSuites);
      setSettings((current) => ({
        ...current,
        targetRoot: response.targetRoot,
      }));
      await refreshRuns(response.targetRoot);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  const suiteBuilderMutation = useMutation({
    mutationFn: (payload: AdminHarnessEvolutionSuiteBuilderPayload) =>
      createHarnessEvolutionSuites(auth.token, payload),
    onSuccess: async (response) => {
      setFormError(null);
      setSelectedRun(null);
      setSelectedManifestPath('');
      setSubmittedTargetRoot(response.targetRoot);
      applyStarterSuites(response.starterSuites);
      setSettings((current) => ({
        ...current,
        targetRoot: response.targetRoot,
      }));
      await refreshRuns(response.targetRoot);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  const runMutation = useMutation({
    mutationFn: (payload: AdminHarnessEvolutionRunPayload) =>
      startHarnessEvolutionRun(auth.token, payload),
    onSuccess: async (response) => {
      setFormError(null);
      const runEntry =
        response.runs.find(
          (entry) => entry.summaryPath === response.run.summaryPath,
        ) || null;
      setSelectedRun(runEntry);
      setSelectedManifestPath('');
      setSubmittedTargetRoot(response.targetRoot);
      await refreshRuns(response.targetRoot);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  const loadRuns = () => {
    const targetRoot = settings.targetRoot.trim();
    if (!targetRoot) {
      setFormError('Target workspace is required.');
      return;
    }
    setFormError(null);
    setSelectedRun(null);
    setSelectedManifestPath('');
    setSubmittedTargetRoot(targetRoot);
  };

  const initializeTarget = () => {
    const targetRoot = settings.targetRoot.trim();
    if (!targetRoot) {
      setFormError('Target workspace is required.');
      return;
    }
    initMutation.mutate(targetRoot);
  };

  const createStarterSuites = () => {
    const targetRoot = settings.targetRoot.trim();
    if (!targetRoot) {
      setFormError('Target workspace is required.');
      return;
    }
    starterSuitesMutation.mutate(targetRoot);
  };

  const createSpreadsheetExample = () => {
    const targetRoot = settings.targetRoot.trim();
    if (!targetRoot) {
      setFormError('Target workspace is required.');
      return;
    }
    spreadsheetExampleMutation.mutate(targetRoot);
  };

  const saveSuiteBuilder = () => {
    try {
      suiteBuilderMutation.mutate(
        buildSuiteBuilderPayload(settings, suiteBuilder),
      );
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  };

  const startRun = () => {
    try {
      runMutation.mutate(buildRunPayload(settings));
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  };

  const pageHeaderProps = {
    description: (
      <>
        Optimize a coworker harness: run train tasks, try bounded edits, and
        keep only candidates that improve held-out selection tasks. Inspired by{' '}
        <a
          href="https://microsoft.github.io/SkillOpt/"
          target="_blank"
          rel="noreferrer"
        >
          SkillOpt
        </a>
        .
      </>
    ),
  };

  return (
    <div className="page-stack">
      <PageHeader {...pageHeaderProps} />

      <RunControlPanel
        buildingSuites={suiteBuilderMutation.isPending}
        creatingStarterSuites={starterSuitesMutation.isPending}
        creatingSpreadsheetExample={spreadsheetExampleMutation.isPending}
        error={formError}
        initializing={initMutation.isPending}
        loadingRuns={runsQuery.isFetching}
        onCreateSpreadsheetExample={createSpreadsheetExample}
        onCreateStarterSuites={createStarterSuites}
        onInitialize={initializeTarget}
        onLoad={loadRuns}
        onSaveSuites={saveSuiteBuilder}
        onSuiteBuilderChange={setSuiteBuilder}
        onSettingsChange={setSettings}
        onStart={startRun}
        running={runMutation.isPending}
        settings={settings}
        suiteBuilder={suiteBuilder}
      />

      {!submittedTargetRoot ? (
        <WhyPanel />
      ) : runsQuery.isError ? (
        <div className="empty-state error">
          {getErrorMessage(runsQuery.error)}
        </div>
      ) : runsQuery.isLoading ? (
        <div className="empty-state">Loading optimization runs...</div>
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard
              label="Runs"
              value={String(runsQuery.data?.runs.length || 0)}
              detail={submittedTargetRoot}
            />
            <MetricCard
              label="Best gated pass rate"
              value={formatPercent(latestRun?.bestPassAt1 || 0)}
              detail={
                latestRun?.bestRound ? `round ${latestRun.bestRound}` : 'none'
              }
            />
            <MetricCard
              label="Rollouts"
              value={String(totalRollouts)}
              detail={`${latestRun?.rounds.length || 0} rounds`}
            />
            <MetricCard
              label="Cost"
              value={formatUsd(latestRun?.costGate.totalCostUsd || 0)}
              detail={
                latestRun?.costGate.budgetUsd == null
                  ? 'no budget'
                  : `${latestRun.costGate.ok ? 'within' : 'over'} budget`
              }
            />
            <MetricCard
              label="Starting changes"
              value={String(latestRun?.seedDelta.changedSurfaceCount || 0)}
              detail={
                latestRun?.seedDelta.mode === 'in_place'
                  ? 'in-place coworker'
                  : 'fresh seed'
              }
            />
            <MetricCard
              label="Accepted candidates"
              value={String(acceptedCandidates)}
              detail={
                latestRun?.bestHarnessPath
                  ? 'best harness exported'
                  : 'no export yet'
              }
            />
          </div>

          <div className="two-column-grid">
            <Card>
              <CardHeader>
                <CardTitle>Runs</CardTitle>
                <CardDescription>
                  Select a completed run to inspect its rounds.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Suite</th>
                        <th>Rounds</th>
                        <th>Best gated score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(runsQuery.data?.runs || []).map((run) => (
                        <tr key={run.summaryPath}>
                          <td>
                            <button
                              type="button"
                              className="table-link-button"
                              onClick={() => {
                                setSelectedRun(run);
                                setSelectedManifestPath('');
                              }}
                            >
                              {run.runId}
                            </button>
                          </td>
                          <td>{run.suiteName}</td>
                          <td>{run.roundCount}</td>
                          <td>{formatPercent(run.bestPassAt1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Rounds</CardTitle>
                <CardDescription>
                  Select a round to inspect the edits proposed during that
                  round.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {runQuery.isError ? (
                  <div className="empty-state error">
                    {getErrorMessage(runQuery.error)}
                  </div>
                ) : (
                  <>
                    <TrajectoryChart rounds={latestRun?.rounds || []} />
                    <SkillOptStagePipeline round={latestRound} />
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Round</th>
                            <th>Train first try</th>
                            <th>Selection first try</th>
                            <th>Gate</th>
                            <th>Successes /M tokens</th>
                            <th>Edits</th>
                            <th>Edit source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(latestRun?.rounds || []).map((round) => (
                            <tr key={round.round}>
                              <td>
                                <button
                                  type="button"
                                  className="table-link-button"
                                  onClick={() =>
                                    setSelectedManifestPath(round.manifestPath)
                                  }
                                >
                                  {round.round}
                                </button>
                              </td>
                              <td>{formatPercent(round.metrics.passAt1)}</td>
                              <td>{formatPercent(gatedPassAt1(round))}</td>
                              <td title={round.selectionGate?.reason}>
                                {formatGate(round)}
                              </td>
                              <td>
                                {formatDecimal(round.metrics.succPerMtok)}
                              </td>
                              <td>{surfaceEdits(round)}</td>
                              <td>
                                {formatEditSource(round.evolveAgent.source)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {latestRun ? (
            <Card>
              <CardHeader>
                <CardTitle>Exported Artifacts</CardTitle>
                <CardDescription>
                  The optimizer keeps the best validated harness separate from
                  rejected edit memory.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="harness-output-list">
                  <div>
                    <strong>Best harness</strong>
                    <span>{latestRun.bestHarnessPath || 'not exported'}</span>
                  </div>
                  <div>
                    <strong>Rejected edit buffer</strong>
                    <span>{latestRun.rejectedEditsPath || 'not recorded'}</span>
                  </div>
                  <div>
                    <strong>Optimizer memory</strong>
                    <span>
                      {latestRun.optimizerMemoryPath || 'not recorded'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Change Manifest</CardTitle>
              <CardDescription>
                Each edit records its prediction, verifier, and rollback status.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {manifestQuery.isError ? (
                <div className="empty-state error">
                  {getErrorMessage(manifestQuery.error)}
                </div>
              ) : manifestEntries.length === 0 ? (
                <div className="empty-state">
                  No edits were proposed for this round.
                </div>
              ) : (
                <ManifestEntries entries={manifestEntries} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function RunControlPanel({
  buildingSuites,
  creatingSpreadsheetExample,
  creatingStarterSuites,
  error,
  initializing,
  loadingRuns,
  onCreateSpreadsheetExample,
  onCreateStarterSuites,
  onInitialize,
  onLoad,
  onSaveSuites,
  onSuiteBuilderChange,
  onSettingsChange,
  onStart,
  running,
  settings,
  suiteBuilder,
}: {
  buildingSuites: boolean;
  creatingSpreadsheetExample: boolean;
  creatingStarterSuites: boolean;
  error: string | null;
  initializing: boolean;
  loadingRuns: boolean;
  onCreateSpreadsheetExample: () => void;
  onCreateStarterSuites: () => void;
  onInitialize: () => void;
  onLoad: () => void;
  onSaveSuites: () => void;
  onSuiteBuilderChange: (builder: HarnessEvolutionSuiteBuilder) => void;
  onSettingsChange: (settings: HarnessEvolutionSettings) => void;
  onStart: () => void;
  running: boolean;
  settings: HarnessEvolutionSettings;
  suiteBuilder: HarnessEvolutionSuiteBuilder;
}) {
  const update = <Key extends keyof HarnessEvolutionSettings>(
    key: Key,
    value: HarnessEvolutionSettings[Key],
  ) => onSettingsChange({ ...settings, [key]: value });
  const updateBuilder = <Key extends keyof HarnessEvolutionSuiteBuilder>(
    key: Key,
    value: HarnessEvolutionSuiteBuilder[Key],
  ) => onSuiteBuilderChange({ ...suiteBuilder, [key]: value });
  const busy =
    initializing ||
    creatingStarterSuites ||
    creatingSpreadsheetExample ||
    buildingSuites ||
    running;

  return (
    <div className="two-column-grid harness-control-grid">
      <Card>
        <CardHeader>
          <CardTitle>Start Optimization</CardTitle>
          <CardDescription>
            Choose a target workspace and eval suites, then run the optimizer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="harness-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              onStart();
            }}
          >
            <label className="harness-field">
              <span>Target workspace</span>
              <input
                value={settings.targetRoot}
                onChange={(event) => update('targetRoot', event.target.value)}
                placeholder={DEFAULT_TARGET_ROOT}
              />
            </label>
            <label className="harness-field">
              <span>Train suite JSON</span>
              <input
                value={settings.suitePath}
                onChange={(event) => update('suitePath', event.target.value)}
                placeholder="/path/to/train-suite.json"
              />
              <small>
                The train tasks are what the optimizer studies before it
                proposes edits. Generate a starter suite below when you do not
                have one yet.
              </small>
            </label>
            <label className="harness-field">
              <span>Selection suite JSON</span>
              <input
                value={settings.selectionSuitePath}
                onChange={(event) =>
                  update('selectionSuitePath', event.target.value)
                }
                placeholder="/path/to/selection-suite.json"
              />
              <small>
                The selection suite is the held-out gate. A candidate is kept
                only when this score improves.
              </small>
            </label>
            <div className="harness-suite-actions">
              <button
                disabled={busy}
                type="button"
                onClick={onCreateStarterSuites}
              >
                {creatingStarterSuites
                  ? 'Creating starter suites...'
                  : 'Create starter suites'}
              </button>
              <button
                disabled={busy}
                type="button"
                onClick={onCreateSpreadsheetExample}
              >
                {creatingSpreadsheetExample
                  ? 'Creating spreadsheet example...'
                  : 'Create SpreadsheetBench example'}
              </button>
              <span>
                Writes <code>evals/train-suite.json</code>,{' '}
                <code>evals/selection-suite.json</code>, or a
                SpreadsheetBench-style formula task in the target workspace,
                then fills both fields.
              </span>
            </div>
            <div className="harness-suite-builder">
              <div className="harness-suite-builder-header">
                <strong>Build train and selection suites</strong>
                <span>
                  Save real task commands as JSON suites. Use{' '}
                  <code>{'{targetRoot}'}</code> in a command when it needs the
                  target workspace path.
                </span>
              </div>
              <div className="harness-settings-row">
                <label className="harness-field">
                  <span>Suite name</span>
                  <input
                    value={suiteBuilder.suiteName}
                    onChange={(event) =>
                      updateBuilder('suiteName', event.target.value)
                    }
                    placeholder="Spreadsheet harness smoke"
                  />
                </label>
                <label className="harness-field">
                  <span>Cost budget USD</span>
                  <input
                    inputMode="decimal"
                    value={suiteBuilder.costBudgetUsd}
                    onChange={(event) =>
                      updateBuilder('costBudgetUsd', event.target.value)
                    }
                    placeholder="0.05"
                  />
                </label>
              </div>
              <label className="harness-field">
                <span>Train commands</span>
                <textarea
                  value={suiteBuilder.trainCommands}
                  onChange={(event) =>
                    updateBuilder('trainCommands', event.target.value)
                  }
                  placeholder={
                    'smoke-train: node verifier/train.mjs {targetRoot}'
                  }
                  rows={3}
                />
              </label>
              <label className="harness-field">
                <span>Selection commands</span>
                <textarea
                  value={suiteBuilder.selectionCommands}
                  onChange={(event) =>
                    updateBuilder('selectionCommands', event.target.value)
                  }
                  placeholder={
                    'smoke-selection: node verifier/selection.mjs {targetRoot}'
                  }
                  rows={3}
                />
              </label>
              <div className="harness-suite-actions">
                <button disabled={busy} type="button" onClick={onSaveSuites}>
                  {buildingSuites
                    ? 'Saving suites...'
                    : 'Save suites and fill fields'}
                </button>
                <span>
                  One command per line. Prefix with <code>task-id:</code> to
                  choose stable task IDs.
                </span>
              </div>
            </div>
            <div className="harness-settings-row">
              <label className="harness-field">
                <span>Rounds</span>
                <input
                  inputMode="numeric"
                  value={settings.rounds}
                  onChange={(event) => update('rounds', event.target.value)}
                />
              </label>
              <label className="harness-field">
                <span>Rollouts / task</span>
                <input
                  inputMode="numeric"
                  value={settings.rolloutsPerTask}
                  onChange={(event) =>
                    update('rolloutsPerTask', event.target.value)
                  }
                />
              </label>
              <label className="harness-field">
                <span>Max edits / round</span>
                <input
                  inputMode="numeric"
                  value={settings.maxEditsPerRound}
                  onChange={(event) =>
                    update('maxEditsPerRound', event.target.value)
                  }
                />
              </label>
            </div>
            <div className="harness-toggle-row">
              <label>
                <input
                  checked={settings.freshSeed}
                  type="checkbox"
                  onChange={(event) =>
                    update('freshSeed', event.target.checked)
                  }
                />
                Fresh seed
              </label>
              <label>
                <input
                  checked={settings.dryRun}
                  type="checkbox"
                  onChange={(event) => update('dryRun', event.target.checked)}
                />
                Dry run
              </label>
              <label>
                <input
                  checked={settings.commit}
                  type="checkbox"
                  onChange={(event) => update('commit', event.target.checked)}
                />
                Commit each round
              </label>
            </div>
            {error ? <div className="empty-state error">{error}</div> : null}
            <div className="harness-action-row">
              <button disabled={busy} type="button" onClick={onInitialize}>
                {initializing ? 'Initializing...' : 'Initialize workspace'}
              </button>
              <button
                disabled={busy || loadingRuns}
                type="button"
                onClick={onLoad}
              >
                {loadingRuns ? 'Loading...' : 'Load runs'}
              </button>
              <button disabled={busy} type="submit">
                {running ? 'Running optimizer...' : 'Start optimization'}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What It Does</CardTitle>
          <CardDescription>
            Use this when a coworker repeatedly fails a known eval suite and you
            want measured improvements, not blind prompt edits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="harness-output-list">
            <div>
              <strong>1. Rollout</strong>
              <span>Runs the train suite and summarizes failure evidence.</span>
            </div>
            <div>
              <strong>2. Reflect</strong>
              <span>
                Compares successes, failures, rejected edits, and optimizer
                memory.
              </span>
            </div>
            <div>
              <strong>3. Select edits</strong>
              <span>
                Proposes a small number of changes to memory, tools, config, or
                prompts.
              </span>
            </div>
            <div>
              <strong>4. Gate</strong>
              <span>
                Keeps the candidate only if the selection suite improves.
              </span>
            </div>
            <div>
              <strong>5. Export</strong>
              <span>
                Writes the best validated harness, rejected-edit buffer, and
                optimizer memory.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function WhyPanel() {
  return (
    <div className="two-column-grid harness-setup-grid">
      <Card>
        <CardHeader>
          <CardTitle>No Runs Loaded</CardTitle>
          <CardDescription>
            Initialize a workspace, start a run, or load an existing target to
            inspect previous optimization results.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="harness-output-list">
            <div>
              <strong>Target workspace</strong>
              <span>Where the harness files and run artifacts are stored.</span>
            </div>
            <div>
              <strong>Train suite</strong>
              <span>
                The tasks the optimizer studies before proposing edits. Use
                Create starter suites to generate one in the target workspace.
              </span>
            </div>
            <div>
              <strong>Selection suite</strong>
              <span>
                The held-out tasks that decide whether edits are kept.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What You Get</CardTitle>
          <CardDescription>
            The run produces reviewable artifacts instead of silently rewriting
            a live coworker.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="harness-output-list">
            <div>
              <strong>Scores</strong>
              <span>
                Train score, held-out selection score, rollout count, token
                efficiency.
              </span>
            </div>
            <div>
              <strong>Proposed edits</strong>
              <span>
                Changes to prompts, tools, middleware, config, or memory.
              </span>
            </div>
            <div>
              <strong>Validation gate</strong>
              <span>
                Prediction, verifier, rollback scope, and status per edit.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ManifestEntries({
  entries,
}: {
  entries: AdminHarnessEvolutionManifestEntry[];
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Surface</th>
            <th>Path</th>
            <th>Prediction</th>
            <th>Verifier command or evidence</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatSurface(entry.surface)}</td>
              <td>{entry.path}</td>
              <td>{entry.prediction}</td>
              <td>{entry.verifier}</td>
              <td>
                {entry.rolledBackAt
                  ? 'rolled back'
                  : entry.confirmed === false
                    ? 'disconfirmed'
                    : entry.confirmed
                      ? 'confirmed'
                      : 'pending'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
