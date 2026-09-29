/**
 * Labs controls plugin-owned decision models independently of the local chat model.
 * Readiness comes from the gateway; choosing a router remains an explicit setting.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LocalClassifierAction,
  LocalClassifierInfo,
} from '../../../src/routing/local-classifiers';
import { requestJson } from '../api/client';
import { useAuth } from '../auth';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
export function LocalClassifiers() {
  const { token } = useAuth();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['local-classifiers', token],
    queryFn: () =>
      requestJson<{ classifiers: LocalClassifierInfo[] }>(
        '/api/admin/local-classifiers',
        { token },
      ),
    refetchInterval: 2500,
  });
  const control = useMutation({
    mutationFn: (body: { model: string; action: LocalClassifierAction }) =>
      requestJson('/api/admin/local-classifiers', {
        token,
        method: 'POST',
        body,
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['local-classifiers', token] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local decision models</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          Run a small routing model alongside your local chat model. Choose it
          as the live or comparison router in{' '}
          <a href="/admin/model-routing">Routing</a>.
        </p>
        {query.isPending && <p role="status">Checking decision models…</p>}
        {(query.isError || control.isError) && (
          <p role="alert">
            Could not access local decision controls. Open the console on
            localhost to manage them.
          </p>
        )}
        {query.data?.classifiers.length === 0 && (
          <p>
            Install the optional Laya Local Router plugin from{' '}
            <a href="/admin/extensions?tab=plugins">Plugins</a>, then return
            here to download and start the multilingual model.
          </p>
        )}
        {query.data?.classifiers.map((model) => (
          <div key={model.model}>
            <h3>{model.label}</h3>
            <p role="status">{model.status}</p>
            {model.error && <p role="alert">{model.error}</p>}
            {!model.supported ? (
              <p>Requires Apple silicon on the gateway host.</p>
            ) : (
              <>
                <p>
                  Setup requires uv and downloads the runtime and weights.
                  Inference stays local. Stopping frees memory; start it again
                  after a gateway restart.
                </p>
                <Button
                  disabled={
                    control.isPending ||
                    ['setup', 'starting'].includes(model.status)
                  }
                  onClick={() =>
                    control.mutate({
                      model: model.model,
                      action:
                        model.status === 'running'
                          ? 'stop'
                          : model.installed
                            ? 'start'
                            : 'setup',
                    })
                  }
                >
                  {model.status === 'running'
                    ? 'Stop decision model'
                    : model.installed
                      ? 'Start decision model'
                      : 'Download & set up decision model'}
                </Button>
                {['setup', 'starting'].includes(model.status) && (
                  <Button
                    disabled={control.isPending}
                    onClick={() =>
                      control.mutate({ model: model.model, action: 'stop' })
                    }
                  >
                    Cancel
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
