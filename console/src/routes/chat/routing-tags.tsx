/**
 * Routing tags render execution evidence without inferring decisions or prices.
 * Unlike activity traces, they contain no reasoning text or tool payloads.
 */

import type { TypedRoutingEvaluation } from '../../../../src/routing/evaluator-contract';
import type {
  RoutingTrace,
  RoutingTraceAttempt,
} from '../../../../src/types/routing-trace';
import css from './routing-tags.module.css';

function costLabel(attempts: RoutingTraceAttempt[]): string {
  if (attempts.some((attempt) => attempt.costUsd === null)) {
    const known = attempts.reduce(
      (sum, attempt) => sum + (attempt.costUsd ?? 0),
      0,
    );
    return known > 0
      ? `Known $${known.toFixed(8)} · partial`
      : 'Cost unavailable';
  }
  const total = attempts.reduce(
    (sum, attempt) => sum + (attempt.costUsd ?? 0),
    0,
  );
  const estimated = attempts.some(
    (attempt) => attempt.costSource === 'estimated',
  );
  return `${estimated ? 'Est. ' : ''}${`$${total.toFixed(total > 0 && total < 0.0001 ? 8 : 4)}`}`;
}

function count(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString();
}

// Normalized totals include cache tokens for Anthropic; other providers already
// include them in input. Subtract output instead of adding cache counters twice.
function totalInput(attempt: RoutingTraceAttempt): number | null {
  if (
    attempt.totalTokens !== null &&
    attempt.outputTokens !== null &&
    attempt.totalTokens >= attempt.outputTokens
  ) {
    return attempt.totalTokens - attempt.outputTokens;
  }
  return attempt.inputTokens;
}

const ZONE_LABELS: Record<string, string> = {
  local: '💻 Local',
  hai: '🏢 HybridAI',
  'eu-provider': '🇪🇺 DE/EU provider',
  region: '🇪🇺 DE/EU hosting',
  cloud: '🌐 World',
};

function RoutingDecisionRow({
  value,
  shadow = false,
  attempts,
}: {
  value: TypedRoutingEvaluation;
  shadow?: boolean;
  attempts: RoutingTraceAttempt[];
}) {
  const failed = value.status !== 'evaluated';
  const call = attempts.find(
    (attempt) =>
      attempt.kind === 'auxiliary' &&
      (attempt.model === value.model ||
        attempt.model === `jev/${value.model}` ||
        (value.provider === 'jev' &&
          attempt.reason === 'typed-routing-evaluator')),
  );
  const cache =
    call?.cacheReadTokens != null || call?.cacheWriteTokens != null
      ? `${call?.cacheReadTokens?.toLocaleString() ?? '—'} read / ${call?.cacheWriteTokens?.toLocaleString() ?? '—'} write`
      : '—';
  return (
    <tr>
      <td>
        <strong>
          {value.provider === 'rules' ? 'Rules (no model)' : value.model}
        </strong>
        <span className={css.role}>{shadow ? 'Shadow' : 'Live'}</span>
      </td>
      <td title={value.reason}>
        {failed ? (
          value.reason === 'low-confidence' && value.distributions?.tier ? (
            `${value.distributions.tier.choice} · low confidence`
          ) : (
            value.reason.replaceAll('-', ' ')
          )
        ) : (
          <>
            {value.recommendedTier ?? 'No selection'}
            {value.selectedModel ? <small>{value.selectedModel}</small> : null}
          </>
        )}
        {value.distributions?.tier ? (
          <small title="Confidence in the tier recommendation.">
            {Math.round(value.distributions.tier.confidence * 100)}% confidence
          </small>
        ) : null}
        {value.reason.includes('local only') ||
        value.reason === 'local-only-classification' ||
        value.reason === 'sensitive-or-uncertain' ? (
          <small>Privacy: local models only</small>
        ) : null}
      </td>
      <td className={css.numeric}>
        {value.durationMs < 1000
          ? `${value.durationMs}ms`
          : `${(value.durationMs / 1000).toFixed(2)}s`}
      </td>
      <td className={css.numeric}>
        {count(call ? totalInput(call) : value.inputTokens)} in /{' '}
        {count(value.outputTokens)} out
      </td>
      <td
        className={css.numeric}
        title="Cache tokens: read / write. A dash means not reported or not applicable."
      >
        {cache}
      </td>
      <td className={css.numeric}>
        {value.costUsd === null
          ? 'Unavailable'
          : value.costUsd === 0
            ? '$0'
            : `Est. $${value.costUsd.toFixed(8)}`}
      </td>
    </tr>
  );
}

export function RoutingTags({ trace }: { trace: RoutingTrace }) {
  if (!trace.attempts.length) return null;
  const execution = trace.attempts.filter(
    (attempt) => attempt.kind === 'execution',
  );
  const overhead = trace.attempts.filter(
    (attempt) => attempt.kind === 'auxiliary',
  );
  const selected = execution.at(-1) ?? trace.attempts.at(-1);
  const running = trace.status === 'running';
  const tokensKnown = trace.attempts.every(
    (attempt) => attempt.totalTokens !== null,
  );
  const totalTokens = trace.attempts.reduce(
    (sum, attempt) => sum + (attempt.totalTokens ?? 0),
    0,
  );
  const tokensEstimated = trace.attempts.some(
    (attempt) => attempt.tokensEstimated,
  );
  return (
    <details className={css.root}>
      <summary className={css.tags} aria-label="Routing and usage details">
        <span
          className={css.model}
          data-zone={selected?.zone}
          title={trace.evaluation?.model}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 12h7m0 0 5-6h4m-9 6 5 6h4M17 3l3 3-3 3m0 6 3 3-3 3" />
          </svg>
          {trace.evaluation?.applied
            ? `${trace.evaluation.provider === 'rules' ? 'Rules' : trace.evaluation.model.split('/').at(-1)} → ${trace.evaluation.recommendedTier ?? selected?.tier ?? 'Selected model'}`
            : trace.evaluation
              ? `Fallback → ${selected?.tier ?? selected?.model ?? 'Pending'}`
              : running && !execution.length
                ? 'Routing…'
                : `${trace.mode === 'direct' ? 'Direct' : 'Configured tiers'} → ${selected?.tier ?? selected?.model ?? 'Pending'}`}
        </span>
        <span className={css.chevron} aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className={css.panel}>
        <p className={css.caption}>
          {running ? (
            `Running · attempt ${trace.attempts.length}`
          ) : (
            <>
              <span>
                {tokensKnown
                  ? `${tokensEstimated ? '≈ ' : ''}${totalTokens.toLocaleString()} tokens`
                  : 'Tokens unavailable'}
              </span>
              {' · '}
              <span>{costLabel(trace.attempts)}</span>
              {execution.length > 1 ? (
                <>
                  {' '}
                  · <span>{execution.length} attempts</span>
                </>
              ) : null}
              {trace.status === 'error' ? ' · Failed' : null}
            </>
          )}
        </p>

        {trace.evaluation || trace.shadowEvaluation ? (
          <div className={css.tableWrap}>
            <table className={css.decisions} aria-label="Routing decisions">
              <thead>
                <tr>
                  <th>Router</th>
                  <th>Result</th>
                  <th>Time</th>
                  <th>Tokens</th>
                  <th>Cache</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {trace.evaluation ? (
                  <RoutingDecisionRow
                    value={trace.evaluation}
                    attempts={trace.attempts}
                  />
                ) : null}
                {trace.shadowEvaluation ? (
                  <RoutingDecisionRow
                    value={trace.shadowEvaluation}
                    shadow
                    attempts={trace.attempts}
                  />
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
        <details className={css.callDetails}>
          <summary>Model calls · {trace.attempts.length}</summary>
          <ol className={css.attempts}>
            {trace.attempts.map((attempt) => (
              <li key={attempt.id} className={css.attempt}>
                <div className={css.heading}>
                  <strong>{attempt.model}</strong>
                  <span className={css.status} data-status={attempt.status}>
                    {attempt.kind === 'auxiliary'
                      ? 'Auxiliary overhead'
                      : 'Execution'}{' '}
                    · {attempt.status}
                  </span>
                </div>
                <p className={css.reason}>
                  {ZONE_LABELS[attempt.zone] ?? attempt.zone}
                  {attempt.tier ? ` · ${attempt.tier}` : ''} ·{' '}
                  {attempt.reason.replaceAll('_', ' ').replaceAll('-', ' ')} ·{' '}
                  {(attempt.durationMs / 1000).toFixed(2)}s
                </p>
                <dl className={css.metrics}>
                  <div>
                    <dt>Total input</dt>
                    <dd>{count(totalInput(attempt))}</dd>
                    <dd className={css.cacheBreakdown}>
                      Cache read:{' '}
                      {attempt.cacheReadTokens === null
                        ? 'Not reported'
                        : count(attempt.cacheReadTokens)}
                      {' · '}Cache write:{' '}
                      {attempt.cacheWriteTokens === null
                        ? 'Not reported'
                        : count(attempt.cacheWriteTokens)}
                    </dd>
                  </div>
                  <div>
                    <dt>Output</dt>
                    <dd>{count(attempt.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>{costLabel([attempt])}</dd>
                  </div>
                </dl>
                {attempt.tokensEstimated ? (
                  <p className={css.caption}>Token counts estimated.</p>
                ) : null}
              </li>
            ))}
          </ol>
          {overhead.length ? (
            <p className={css.caption}>
              Auxiliary overhead included: {costLabel(overhead)} ·{' '}
              {overhead.reduce((sum, attempt) => sum + attempt.durationMs, 0)}ms
              of model calls.
            </p>
          ) : null}
        </details>
      </div>
    </details>
  );
}
