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
import localStyles from '../routes/local-models.module.css';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import styles from './local-classifiers.module.css';

const SETUP_STEPS = [
  ['setup', 'Prepare runtime'],
  ['downloading', 'Download & verify'],
  ['starting', 'Load model'],
] as const;
const STATUS = {
  stopped: {
    label: 'Stopped',
    detail: 'Start the model when you need it. Stopping frees its memory.',
  },
  setup: {
    label: 'Preparing runtime',
    detail:
      'Installing the isolated runtime. This can take a few minutes on first setup.',
  },
  downloading: {
    label: 'Downloading model',
    detail:
      'Downloading and verifying model weights. You can leave this page and come back.',
  },
  starting: {
    label: 'Loading model',
    detail: 'Checking the local model files and loading them into memory.',
  },
  running: {
    label: 'Running locally',
    detail:
      'Ready for routing. Choose it as your live or comparison router in Routing.',
  },
  error: {
    label: 'Needs attention',
    detail: 'The model is unavailable. Review the error below, then retry.',
  },
};

function DecisionModel({
  model,
  pending,
  command,
}: {
  model: LocalClassifierInfo;
  pending: boolean;
  command: (action: LocalClassifierAction) => void;
}) {
  const step = SETUP_STEPS.findIndex(([status]) => status === model.status);
  const busy = step !== -1;
  const status = STATUS[model.status];
  const uninstalled = model.status === 'stopped' && !model.installed;
  return (
    <Card
      className={localStyles.recommended}
      aria-label={model.label}
      aria-busy={busy}
    >
      <CardHeader>
        <span
          className={`${localStyles.badge} ${styles.badge}`}
          data-status={model.status}
          role="status"
        >
          {busy && <span className={styles.dot} aria-hidden="true" />}
          {uninstalled
            ? 'Not installed'
            : model.status === 'stopped'
              ? 'Installed · stopped'
              : status.label}
        </span>
        <CardTitle>{model.label}</CardTitle>
      </CardHeader>
      <CardContent className={localStyles.content}>
        <p>Local routing decisions · separate from your chat model</p>
        {busy && (
          <ol className={styles.steps} aria-label="Decision model setup">
            {SETUP_STEPS.map(([id, label], index) => (
              <li
                key={id}
                aria-current={index === step ? 'step' : undefined}
                data-complete={index < step}
              >
                <span className={styles.stepNumber} aria-hidden="true">
                  {index < step ? '✓' : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        )}
        {model.error && (
          <p className={styles.error} role="alert">
            {model.error}
          </p>
        )}
        {!model.supported ? (
          <p>Requires Apple silicon on the gateway host.</p>
        ) : (
          <div className={localStyles.actions}>
            {busy ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => command('stop')}
              >
                Cancel
              </Button>
            ) : (
              <Button
                disabled={pending}
                onClick={() =>
                  command(
                    model.status === 'running'
                      ? 'stop'
                      : model.installed
                        ? 'start'
                        : 'setup',
                  )
                }
              >
                {model.status === 'running'
                  ? 'Stop model'
                  : model.installed
                    ? 'Start model'
                    : 'Download & set up'}
              </Button>
            )}
            <a href="/admin/model-routing">Routing settings</a>
          </div>
        )}
        <p className={localStyles.hint}>
          {uninstalled
            ? 'Set up once to run routing decisions on this Mac. Requires uv; runtime and model files are downloaded during setup.'
            : status.detail}
        </p>
      </CardContent>
    </Card>
  );
}
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
    <div className={styles.content}>
      <CardTitle>Local decision models</CardTitle>
      <p>
        Run a small routing model alongside your local chat model. Choose it as
        the live or comparison router in{' '}
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
          <a href="/admin/extensions?tab=plugins">Plugins</a>, then return here
          to download and start the multilingual model.
        </p>
      )}
      {query.data?.classifiers.map((model) => (
        <DecisionModel
          key={model.model}
          model={model}
          pending={control.isPending || query.isError}
          command={(action) => control.mutate({ model: model.model, action })}
        />
      ))}
    </div>
  );
}
