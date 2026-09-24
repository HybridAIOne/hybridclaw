/**
 * Displays classifier evidence separately from the route actually executed.
 * Only closed labels and metadata are rendered; recommendations grant no authority.
 */
import type { TypedRoutingEvaluation } from '../../../src/routing/evaluator-contract';
export function RoutingEvaluation({
  value,
}: {
  value: TypedRoutingEvaluation;
}) {
  return (
    <section aria-label="Typed routing evaluation">
      <p>
        <strong>
          {value.provider.toUpperCase()} · {value.mode}
          {value.applied ? ' · applied' : ' · not applied'}
        </strong>{' '}
        · {value.durationMs}ms
      </p>
      <p>
        {value.reason.replaceAll('-', ' ')}
        {value.recommendedTier
          ? ` · Recommended tier: ${value.recommendedTier}`
          : ''}
      </p>
      {value.selectedModel ? <p>{value.selectedModel}</p> : null}
      {value.distributions ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {Object.entries(value.distributions).map(([name, answer]) => (
            <details key={name}>
              <summary>
                {name === 'pii'
                  ? 'Personal data'
                  : name.charAt(0).toUpperCase() + name.slice(1)}{' '}
                · {answer.choice} · {(answer.confidence * 100).toFixed(0)}%
                confidence
              </summary>
              {Object.entries(answer.probabilities).map(
                ([label, probability]) => (
                  <div
                    key={label}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '110px minmax(80px, 1fr) 48px',
                      gap: 8,
                      alignItems: 'center',
                      marginTop: 6,
                    }}
                  >
                    <span>{label}</span>
                    <meter
                      min={0}
                      max={1}
                      value={probability}
                      aria-label={`${name}: ${label}`}
                      style={{ width: '100%', accentColor: 'var(--primary)' }}
                    />
                    <span>{(probability * 100).toFixed(0)}%</span>
                  </div>
                ),
              )}
            </details>
          ))}
        </div>
      ) : null}
      <p style={{ color: 'var(--muted-foreground)', fontSize: '0.8125rem' }}>
        {value.model} · {value.inputTokens ?? 'Unknown'} input /{' '}
        {value.outputTokens ?? 'Unknown'} output tokens ·{' '}
        {value.costUsd === null
          ? 'Cost unavailable'
          : `Est. $${value.costUsd.toFixed(8)}`}
      </p>
    </section>
  );
}
