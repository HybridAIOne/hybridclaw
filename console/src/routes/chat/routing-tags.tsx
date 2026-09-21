/**
 * Routing tags render execution evidence without inferring decisions or prices.
 * Unlike activity traces, they contain no reasoning text or tool payloads.
 */
import type {
  RoutingTrace,
  RoutingTraceAttempt,
} from '../../../../src/types/routing-trace';
import { RoutingEvaluation } from '../../components/routing-evaluation';
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

const MODE_LABELS = {
  direct: 'Direct',
  concierge: 'Concierge',
  tiered: 'Tiered',
};
const MODE_DESCRIPTIONS = {
  direct:
    'Used the selected model directly, without concierge or tier-based selection.',
  concierge:
    'The concierge evaluated this request; expand to inspect its decision and execution.',
  tiered:
    'Selected through the configured routing tiers; expand to inspect each attempt.',
};
const ZONE_LABELS: Record<string, string> = {
  local: 'Local',
  hai: 'HybridAI',
  region: 'Regional',
  cloud: 'Cloud',
};

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
        <span className={css.tag} title={MODE_DESCRIPTIONS[trace.mode]}>
          {running && !execution.length ? 'Routing' : MODE_LABELS[trace.mode]}
        </span>
        {trace.evaluation ? (
          <span
            className={css.tag}
            title={`${trace.evaluation.model}: ${trace.evaluation.reason.replaceAll('-', ' ')}`}
          >
            {trace.evaluation.provider.toUpperCase()} ·{' '}
            {trace.evaluation.applied
              ? `Selected ${trace.evaluation.recommendedTier}`
              : trace.evaluation.recommendedTier
                ? `Suggested ${trace.evaluation.recommendedTier}`
                : trace.evaluation.reason.replaceAll('-', ' ')}
          </span>
        ) : null}
        {selected ? (
          <span className={css.model} data-zone={selected.zone}>
            <span className={css.routeDot} aria-hidden="true" />
            {ZONE_LABELS[selected.zone] ?? selected.zone} · {selected.model}
          </span>
        ) : null}
        {running ? (
          <span className={css.running}>
            Running · attempt {trace.attempts.length}
          </span>
        ) : (
          <>
            <span className={css.tag}>
              {tokensKnown
                ? `${tokensEstimated ? '≈ ' : ''}${totalTokens.toLocaleString()} tokens`
                : 'Tokens unavailable'}
            </span>
            <span className={css.tag}>{costLabel(trace.attempts)}</span>
            {execution.length > 1 ? (
              <span className={css.tag} data-tone="retry">
                {execution.length} attempts
              </span>
            ) : null}
            {trace.status === 'error' ? (
              <span className={css.tag} data-tone="error">
                Failed
              </span>
            ) : null}
          </>
        )}
        <span className={css.chevron} aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className={css.panel}>
        {trace.evaluation ? (
          <RoutingEvaluation value={trace.evaluation} />
        ) : null}
        <p className={css.caption}>
          {running
            ? 'Usage settles when the response finishes.'
            : `Model usage across all recorded attempts · ${(trace.durationMs / 1000).toFixed(1)}s elapsed`}
        </p>
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
                  <dt>Input</dt>
                  <dd>{count(attempt.inputTokens)}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{count(attempt.outputTokens)}</dd>
                </div>
                <div>
                  <dt>Cache read</dt>
                  <dd>{count(attempt.cacheReadTokens)}</dd>
                </div>
                <div>
                  <dt>Cache write</dt>
                  <dd>{count(attempt.cacheWriteTokens)}</dd>
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
        <p className={css.caption}>
          Estimates use catalog token rates; cache discounts may differ.
          Unavailable means unreported usage or missing pricing. Local compute
          and non-model tool charges are excluded.
        </p>
      </div>
    </details>
  );
}
