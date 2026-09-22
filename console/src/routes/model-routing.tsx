/**
 * Routing owns the live/comparison routers and execution tier configuration.
 * Provider credentials and model inventory remain on Providers; this page does not edit them.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchModels } from '../api/client';
import { useAuth } from '../auth';
import { RoutingConfiguration } from '../components/routing-configuration';
export function ModelRoutingPage() {
  const { token } = useAuth();
  const models = useQuery({
    queryKey: ['models', token],
    queryFn: () => fetchModels(token),
  });
  return (
    <div className="page-stack">
      <RoutingConfiguration models={models.data?.models ?? []} />
    </div>
  );
}
