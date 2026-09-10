/**
 * Labs setup is visible only on supported Apple silicon gateway hosts.
 * This page never selects remote fallback or marks a download ready before
 * local checks pass; provider endpoint editing remains on Providers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { controlLocalModel, fetchLocalModels } from '../api/client';
import type {
  AdminLocalModelCommand,
  AdminLocalModelsResponse,
} from '../api/types';
import { useAuth } from '../auth';
import { useAppShellConfig } from '../components/app-shell';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { LocalModelMetrics } from './local-model-metrics';
import styles from './local-models.module.css';

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;
const STAGES = [
  ['runtime', 'Prepare runtime'],
  ['download', 'Download & verify'],
  ['loading', 'Load model'],
  ['checking', 'Check tools'],
  ['activating', 'Save setup'],
] as const;

function SetupProgress({
  job,
  cancel,
  pending,
}: {
  job: NonNullable<AdminLocalModelsResponse['job']>;
  cancel: () => void;
  pending: boolean;
}) {
  const step = STAGES.findIndex(([id]) => id === job.stage);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {job.status === 'cancelling'
            ? 'Cancelling setup…'
            : job.action === 'setup'
              ? 'Setting up your local model'
              : job.action === 'start'
                ? job.stage === 'connecting'
                  ? 'Connecting local model…'
                  : 'Starting local model…'
                : 'Stopping local model…'}
        </CardTitle>
      </CardHeader>
      <CardContent className={styles.content}>
        {job.action === 'setup' && (
          <ol className={styles.steps} aria-label="Setup progress">
            {STAGES.map(([id, label], index) => (
              <li
                key={id}
                aria-current={index === step ? 'step' : undefined}
                data-complete={index < step}
              >
                <span className={styles.stepNumber}>
                  {index < step ? '✓' : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        )}
        <p role="status">
          {job.stage === 'download'
            ? 'Downloading model files and verifying their integrity. Large downloads can take a while.'
            : 'The Mac is working. You can leave this page and come back.'}
        </p>
        <Button
          variant="outline"
          disabled={pending || job.status === 'cancelling'}
          onClick={cancel}
        >
          Cancel
        </Button>
      </CardContent>
    </Card>
  );
}

export function LocalModelsPage() {
  const { localModelsSupported } = useAppShellConfig();
  if (!localModelsSupported) return <Navigate to="/admin/models" replace />;
  return <MacLocalModelsPage />;
}

function MacLocalModelsPage() {
  const { token } = useAuth();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['local-models', token],
    queryFn: () => fetchLocalModels(token),
    // 2026-09-10, console setup choice: poll while visible; jobs live in the gateway.
    refetchInterval: (query) => (query.state.status === 'error' ? false : 2500),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (command: AdminLocalModelCommand) =>
      controlLocalModel(token, command),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['local-models', token] });
      await client.invalidateQueries({ queryKey: ['models', token] });
    },
  });
  const data = query.data;
  const running = data?.running;
  const connected = data?.connected;
  const installedModelId = data?.installation?.modelId;
  useEffect(() => {
    if (running === undefined || connected === undefined || !installedModelId)
      return;
    // Commands return before startup finishes; refresh again on the observed state.
    void client.invalidateQueries({ queryKey: ['models', token] });
  }, [client, token, running, connected, installedModelId]);
  const selected = data?.candidates.find(
    (model) =>
      model.id === (selectedId ?? data.recommended) &&
      model.id !== data.installation?.modelId,
  );
  const busy =
    data?.job?.status === 'running' || data?.job?.status === 'cancelling';
  const enoughDisk =
    selected &&
    data &&
    data.freeDiskBytes >= selected.weightBytes * 1.1 + 2 * GIB;
  const installed = data?.candidates.find(
    (model) => model.id === data.installation?.modelId,
  );
  const activeModel = data?.installation && !busy;

  return (
    <div className={styles.page}>
      <PageHeader
        description="Run a model on your Mac. Setup picks from the current shortlist and leaves room for macOS and your other apps."
        actions={
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Refresh
          </Button>
        }
      />
      {query.isPending && (
        <p role="status">Checking the gateway Mac and available memory…</p>
      )}
      {query.error && (
        <div className={styles.notice} role="alert">
          <strong>Local model controls are unavailable</strong>
          <p>{getErrorMessage(query.error)}</p>
          <p>
            If you just updated HybridClaw, restart the gateway to load the
            setup API, then refresh this page. Open the console using localhost
            on the gateway Mac.
          </p>
        </div>
      )}
      {data && (
        <>
          <div className={styles.hardware}>
            <div>
              <span className={styles.eyebrow}>Gateway Mac</span>
              <strong>{data.hardware.chip}</strong>
              <span>{gib(data.hardware.memoryBytes)} unified memory</span>
            </div>
            <div>
              <span className={styles.eyebrow}>Available for inference</span>
              <strong>{gib(data.memoryLimitBytes)}</strong>
              <span>Estimated with system headroom</span>
            </div>
            <div>
              <span className={styles.eyebrow}>Free storage</span>
              <strong>{gib(data.freeDiskBytes)}</strong>
              <span>Model files stay on this Mac</span>
            </div>
          </div>
          {data.supported && (
            <LocalModelMetrics
              sample={data.metrics}
              running={data.running}
              stale={query.isError}
            />
          )}
          {!data.supported && (
            <div className={styles.notice}>
              Managed setup requires Apple silicon and macOS 15 or later on the
              gateway host. You can connect an existing local server in{' '}
              <a href="/admin/models">Providers</a>.
            </div>
          )}
          {data.supported && !data.uvAvailable && (
            <div className={styles.notice}>
              <strong>One prerequisite: uv</strong>
              <p>
                Install the Python package manager on the gateway Mac, then
                refresh. Setup uses it to prepare the isolated MLX runtime.
              </p>
              <a
                href="https://docs.astral.sh/uv/getting-started/installation/"
                target="_blank"
                rel="noreferrer"
              >
                Install uv ↗
              </a>
            </div>
          )}
          {mutation.error && (
            <p role="alert" className={styles.notice}>
              {getErrorMessage(mutation.error)}
            </p>
          )}
          {data.installationError && (
            <p role="alert" className={styles.notice}>
              {data.installationError}
            </p>
          )}
          {data.job?.status === 'failed' && (
            <p role="alert" className={styles.notice}>
              {data.job.error}
            </p>
          )}
          {data.job?.status === 'cancelled' && (
            <p role="status">
              Operation cancelled. Cached model files are kept for a later
              retry.
            </p>
          )}
          {busy && data.job && (
            <SetupProgress
              job={data.job}
              pending={mutation.isPending}
              cancel={() => mutation.mutate({ action: 'cancel' })}
            />
          )}
          {activeModel && (
            <Card className={styles.recommended}>
              <CardHeader>
                <span className={styles.badge}>
                  {data.running ? 'Running locally' : 'Installed · stopped'}
                </span>
                <CardTitle>
                  {installed?.label ?? data.installation?.modelId}
                </CardTitle>
              </CardHeader>
              <CardContent className={styles.content}>
                <p>
                  {data.installation?.contextWindow.toLocaleString()} token
                  context · MLX on Apple silicon
                </p>
                <div className={styles.actions}>
                  <Button
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        action: data.running ? 'stop' : 'start',
                      })
                    }
                  >
                    {data.running ? 'Stop model' : 'Start model'}
                  </Button>
                  {data.running && !data.connected && (
                    <Button
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate({ action: 'start' })}
                    >
                      Connect to chat
                    </Button>
                  )}
                  {data.running && data.connected && (
                    <a href="/chat">Open chat →</a>
                  )}
                  <a href="/admin/models">Provider settings</a>
                </div>
                <p className={styles.hint}>
                  {data.running
                    ? data.connected
                      ? 'Select this local model in chat to use it.'
                      : 'The model is running. Connect it to make it available in chat.'
                    : 'Start the model when you need it. Stopping frees its memory.'}
                </p>
              </CardContent>
            </Card>
          )}
          {data.supported && !busy && !data.running && (
            <>
              {selected ? (
                <Card className={activeModel ? undefined : styles.recommended}>
                  <CardHeader>
                    <span className={styles.badge}>
                      {selected.id === data.recommended
                        ? 'Recommended for this Mac'
                        : 'Your selection'}
                    </span>
                    <CardTitle>{selected.label}</CardTitle>
                  </CardHeader>
                  <CardContent className={styles.content}>
                    <p>
                      Chosen for your available memory. Close other apps to make
                      room for larger models.
                    </p>
                    <div className={styles.facts}>
                      <div>
                        <strong>{gib(selected.weightBytes)}</strong>
                        <span>Model download</span>
                      </div>
                      <div>
                        <strong>{gib(selected.requiredBytes)}</strong>
                        <span>Estimated memory</span>
                      </div>
                      <div>
                        <strong>
                          {selected.contextWindow.toLocaleString()}
                        </strong>
                        <span>Token context</span>
                      </div>
                    </div>
                    {!selected.fits && (
                      <p role="status">
                        This model no longer fits the available memory. Close
                        other apps or choose a smaller model below.
                      </p>
                    )}
                    {!enoughDisk && (
                      <p role="status">
                        More storage is needed: allow{' '}
                        {gib(selected.weightBytes * 1.1 + 2 * GIB)} for the
                        model and runtime.
                      </p>
                    )}
                    <div className={styles.actions}>
                      <Button
                        disabled={
                          mutation.isPending ||
                          !selected.fits ||
                          !data.uvAvailable ||
                          !enoughDisk
                        }
                        onClick={() =>
                          mutation.mutate({
                            action: 'setup',
                            modelId: selected.id,
                          })
                        }
                      >
                        {activeModel
                          ? 'Set up selected model'
                          : 'Download & set up'}
                      </Button>
                      <span className={styles.hint}>
                        {selected.license} license
                      </span>
                    </div>
                    <p className={styles.hint}>
                      Setup downloads the runtime and model, then checks local
                      streaming and tool use before saving the provider.
                    </p>
                    <details>
                      <summary>Model details</summary>
                      <p className={styles.hint}>
                        <a
                          href={`https://huggingface.co/${selected.repo}/tree/${selected.revision}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View the pinned model artifact ↗
                        </a>
                      </p>
                      <code className={styles.revision}>
                        {selected.revision}
                      </code>
                    </details>
                  </CardContent>
                </Card>
              ) : !data.installation ? (
                <div className={styles.notice}>
                  No model currently fits the available memory. Close
                  memory-heavy apps and refresh, or connect an existing server.
                </div>
              ) : null}
              <details className={styles.compare}>
                <summary>Compare models from the shortlist</summary>
                <div className={styles.modelList}>
                  {data.candidates.map((model) => (
                    <div key={model.id} className={styles.modelRow}>
                      <div>
                        <strong>{model.label}</strong>
                        <p>
                          {gib(model.weightBytes)} download ·{' '}
                          {model.fits
                            ? `${model.contextWindow.toLocaleString()} token context`
                            : 'Needs more available memory'}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={
                          !model.fits || model.id === data.installation?.modelId
                        }
                        onClick={() => setSelectedId(model.id)}
                      >
                        {model.id === data.installation?.modelId
                          ? 'Installed'
                          : model.id === selected?.id
                            ? 'Selected'
                            : `Choose ${model.label}`}
                      </Button>
                    </div>
                  ))}
                </div>
                <h4>Also on the shortlist</h4>
                <p className={styles.hint}>
                  These entries do not yet have a supported, pinned Mac
                  installation.
                </p>
                {data.unavailable.map((model) => (
                  <div className={styles.unavailable} key={model.id}>
                    <a
                      href={`https://huggingface.co/${model.sourceRepo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {model.label} ↗
                    </a>
                    <p>{model.reason}</p>
                  </div>
                ))}
              </details>
            </>
          )}
          <div className={styles.footer}>
            <strong>Already using LM Studio, Ollama or another server?</strong>
            <a href="/admin/models">Connect it in Providers →</a>
          </div>
          <p className={styles.hint}>
            Inference runs on the gateway Mac. Task tools and other providers
            follow their own data policies.
          </p>
        </>
      )}
    </div>
  );
}
