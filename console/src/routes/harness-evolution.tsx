import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  fetchHarnessEvolutionManifest,
  fetchHarnessEvolutionRun,
  fetchHarnessEvolutionRuns,
} from '../api/client';
import type {
  AdminHarnessEvolutionManifestEntry,
  AdminHarnessEvolutionRound,
  AdminHarnessEvolutionRunListEntry,
} from '../api/types';
import { useAuth } from '../auth';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { MetricCard, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

const METRIC_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});

function formatDecimal(value: number): string {
  return METRIC_NUMBER_FORMATTER.format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function surfaceEdits(round: AdminHarnessEvolutionRound): string {
  const edits = Object.entries(round.editsPerSurface)
    .filter(([, count]) => count > 0)
    .map(([surface, count]) => `${surface}: ${count}`)
    .join(', ');
  return edits || 'none';
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
        Math.max(0, Math.min(1, round.metrics.passAt1)) *
          (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function TrajectoryChart({ rounds }: { rounds: AdminHarnessEvolutionRound[] }) {
  const points = trajectoryPoints(rounds);
  if (!points) return <div className="empty-state">No trajectory yet.</div>;
  return (
    <svg
      aria-label="pass@1 trajectory"
      role="img"
      viewBox="0 0 320 96"
      style={{ width: '100%', height: 120, marginBottom: 16 }}
    >
      <title>pass@1 trajectory</title>
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

export function HarnessEvolutionPage() {
  const auth = useAuth();
  const [targetRoot, setTargetRoot] = useState('');
  const [submittedTargetRoot, setSubmittedTargetRoot] = useState('');
  const [selectedRun, setSelectedRun] =
    useState<AdminHarnessEvolutionRunListEntry | null>(null);
  const [selectedManifestPath, setSelectedManifestPath] = useState('');

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

  const actions = (
    <form
      className="header-actions"
      onSubmit={(event) => {
        event.preventDefault();
        setSelectedRun(null);
        setSelectedManifestPath('');
        setSubmittedTargetRoot(targetRoot.trim());
      }}
    >
      <input
        value={targetRoot}
        onChange={(event) => setTargetRoot(event.target.value)}
        placeholder="/path/to/target"
        style={{ minWidth: 320 }}
      />
      <button type="submit">Load</button>
    </form>
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="Harness Evolution"
        description="R10a run telemetry, attribution, and F12 manifests."
        actions={actions}
      />

      {!submittedTargetRoot ? (
        <div className="empty-state">Enter a target coworker workspace.</div>
      ) : runsQuery.isError ? (
        <div className="empty-state error">
          {getErrorMessage(runsQuery.error)}
        </div>
      ) : runsQuery.isLoading ? (
        <div className="empty-state">Loading harness evolution runs...</div>
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard
              label="Runs"
              value={String(runsQuery.data?.runs.length || 0)}
              detail={submittedTargetRoot}
            />
            <MetricCard
              label="Best pass@1"
              value={formatDecimal(latestRun?.bestPassAt1 || 0)}
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
              label="Seed delta"
              value={String(latestRun?.seedDelta.changedSurfaceCount || 0)}
              detail={
                latestRun?.seedDelta.mode === 'in_place'
                  ? 'in-place coworker'
                  : 'fresh seed'
              }
            />
          </div>

          <div className="two-column-grid">
            <Card>
              <CardHeader>
                <CardTitle>Runs</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Suite</th>
                        <th>Rounds</th>
                        <th>Best</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(runsQuery.data?.runs || []).map((run) => (
                        <tr
                          key={run.summaryPath}
                          onClick={() => {
                            setSelectedRun(run);
                            setSelectedManifestPath('');
                          }}
                        >
                          <td>{run.runId}</td>
                          <td>{run.suiteName}</td>
                          <td>{run.roundCount}</td>
                          <td>{formatDecimal(run.bestPassAt1)}</td>
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
              </CardHeader>
              <CardContent>
                {runQuery.isError ? (
                  <div className="empty-state error">
                    {getErrorMessage(runQuery.error)}
                  </div>
                ) : (
                  <>
                    <TrajectoryChart rounds={latestRun?.rounds || []} />
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Round</th>
                            <th>pass@1</th>
                            <th>Succ/Mtok</th>
                            <th>Attribution</th>
                            <th>Edits</th>
                            <th>Evolve</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(latestRun?.rounds || []).map((round) => (
                            <tr
                              key={round.round}
                              onClick={() =>
                                setSelectedManifestPath(round.manifestPath)
                              }
                            >
                              <td>{round.round}</td>
                              <td>{formatDecimal(round.metrics.passAt1)}</td>
                              <td>
                                {formatDecimal(round.metrics.succPerMtok)}
                              </td>
                              <td>{formatDecimal(round.attributionScore)}</td>
                              <td>{surfaceEdits(round)}</td>
                              <td>{round.evolveAgent.source}</td>
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

          <Card>
            <CardHeader>
              <CardTitle>F12 Manifest</CardTitle>
            </CardHeader>
            <CardContent>
              {manifestQuery.isError ? (
                <div className="empty-state error">
                  {getErrorMessage(manifestQuery.error)}
                </div>
              ) : manifestEntries.length === 0 ? (
                <div className="empty-state">No manifest entries.</div>
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
            <th>Verifier</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.surface}</td>
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
