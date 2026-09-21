/**
 * Labs hosts the experimental routing evaluator and its playground.
 * Production concierge and execution-tier configuration stay on Providers.
 */
import { RoutingEvaluatorSettings } from '../components/routing-evaluator-settings';

export function RoutingEvaluatorPage() {
  return (
    <div className="page-stack">
      <RoutingEvaluatorSettings />
    </div>
  );
}
