import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  RoutingTrace,
  RoutingTraceAttempt,
} from '../../../../src/types/routing-trace';
import { RoutingTags } from './routing-tags';

const attempt: RoutingTraceAttempt = {
  id: 1,
  kind: 'execution',
  model: 'test-model',
  zone: 'local',
  reason: 'default-start',
  tier: 'economy',
  status: 'success',
  durationMs: 50,
  inputTokens: 20,
  outputTokens: 10,
  totalTokens: 30,
  cacheReadTokens: 5,
  cacheWriteTokens: null,
  tokensEstimated: false,
  costUsd: 0.01,
  costSource: 'estimated',
};
function trace(attempts = [attempt]): RoutingTrace {
  return {
    version: 1,
    mode: 'tiered',
    status: 'complete',
    attempts,
    durationMs: 100,
  };
}

describe('routing tags', () => {
  it('includes failed attempts and auxiliary overhead in totals', () => {
    render(
      <RoutingTags
        trace={trace([
          attempt,
          {
            ...attempt,
            id: 2,
            kind: 'auxiliary',
            model: 'router',
            costUsd: 0.02,
          },
          { ...attempt, id: 3, status: 'error', costUsd: 0.03 },
        ])}
      />,
    );
    expect(screen.getByText('90 tokens')).not.toBeNull();
    expect(screen.getByText('Est. $0.0600')).not.toBeNull();
    expect(screen.getByText('2 attempts')).not.toBeNull();
    expect(
      screen.getByText(/Auxiliary overhead included: Est. \$0.0200/),
    ).not.toBeNull();
    expect(
      screen
        .getByLabelText('Routing and usage details')
        .closest('details')
        ?.hasAttribute('open'),
    ).toBe(false);
  });
  it('does not present missing prices or usage as zero', () => {
    render(
      <RoutingTags
        trace={trace([
          {
            ...attempt,
            costUsd: null,
            costSource: 'unknown',
            totalTokens: null,
          },
        ])}
      />,
    );
    expect(screen.getAllByText('Cost unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('Tokens unavailable')).not.toBeNull();
    expect(screen.queryByText('$0.0000')).toBeNull();
  });
  it('shows live routing without claiming final totals', () => {
    render(<RoutingTags trace={{ ...trace(), status: 'running' }} />);
    expect(screen.getByText('Running · attempt 1')).not.toBeNull();
    expect(screen.queryByText('30 tokens')).toBeNull();
  });
});

it.each([true, false])(
  'shows whether a JEV recommendation was applied (%s)',
  (applied) => {
    render(
      <RoutingTags
        trace={{
          ...trace(),
          mode: 'concierge',
          evaluation: {
            version: 1,
            provider: 'jev',
            mode: 'active',
            status: 'evaluated',
            reason: 'capability-recommendation',
            model: 'jev-test',
            durationMs: 20,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: null,
            distributions: null,
            recommendedTier: 'advanced',
            applied,
          },
        }}
      />,
    );
    expect(
      screen.getByText(`JEV · ${applied ? 'Selected' : 'Suggested'} advanced`),
    ).not.toBeNull();
    expect(screen.getByText('Concierge')).not.toBeNull();
  },
);

it('shows small classifier costs and known partial totals', () => {
  render(
    <RoutingTags
      trace={trace([
        {
          ...attempt,
          id: 1,
          kind: 'auxiliary',
          model: 'jev/jev-latest',
          costUsd: 0.000036918,
        },
        { ...attempt, id: 2, costUsd: null },
      ])}
    />,
  );
  expect(screen.getByText('Known $0.00003692 · partial')).not.toBeNull();
  expect(screen.getAllByText(/Est. \$0.00003692/).length).toBeGreaterThan(0);
});
