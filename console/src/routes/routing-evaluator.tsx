/**
 * Labs hosts the experimental routing evaluator and its playground.
 * Production concierge and execution-tier configuration stay on Providers.
 */
import { RoutingComparison } from '../components/routing-comparison';
import { RoutingEvaluatorSettings } from '../components/routing-evaluator-settings';

export function RoutingEvaluatorPage() {
  return (
    <div className="page-stack">
      <RoutingComparison />
      <RoutingEvaluatorSettings />
    </div>
  );
}
