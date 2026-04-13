import { type MessagePort, parentPort, workerData } from 'node:worker_threads';

import { env, pipeline } from '@huggingface/transformers';

interface WorkerBootstrapData {
  model: string;
  revision: string;
  dtype: 'fp32' | 'q8' | 'q4';
  cacheDir: string;
  control: SharedArrayBuffer;
  port: MessagePort;
}

interface TransformersWorkerRequest {
  requestId: number;
  kind: 'embed' | 'warmup';
  text?: string;
}

interface TransformersWorkerStatus {
  type: 'status';
  stage: string;
  requestId: number | null;
  detail: string | null;
}

const { model, revision, dtype, cacheDir, control, port } =
  workerData as WorkerBootstrapData;
const controlState = new Int32Array(control);

type FeatureExtractor = (
  text: string,
  options: {
    pooling: 'mean';
    normalize: true;
  },
) => Promise<{ data: ArrayLike<number> }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

if (!parentPort) {
  throw new Error('Transformers embedding worker requires a parent port.');
}

env.cacheDir = cacheDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;

emitStatus('worker-started', null, `model=${model} dtype=${dtype}`);

parentPort.on('message', (message: TransformersWorkerRequest) => {
  void handleRequest(message);
});

async function handleRequest(
  message: TransformersWorkerRequest,
): Promise<void> {
  try {
    emitStatus(message.kind, message.requestId, buildRequestDetail(message));
    const extractor = await getExtractor();
    const output =
      message.kind === 'embed'
        ? await extractor(String(message.text || ''), {
            pooling: 'mean',
            normalize: true,
          })
        : null;
    port.postMessage({
      requestId: message.requestId,
      ok: true,
      embedding: output ? Array.from(output.data) : null,
    });
    emitStatus(`${message.kind}-completed`, message.requestId, null);
  } catch (error) {
    emitStatus(
      'request-failed',
      message.requestId,
      error instanceof Error ? error.message : String(error),
    );
    port.postMessage({
      requestId: message.requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Transformers.js embedding failed: ${String(error)}`,
    });
  } finally {
    Atomics.store(controlState, 0, 1);
    Atomics.notify(controlState, 0);
  }
}

async function getExtractor() {
  if (!extractorPromise) {
    emitStatus(
      'pipeline-loading',
      null,
      `model=${model} revision=${revision} dtype=${dtype}`,
    );
    const createPipeline = pipeline as unknown as (
      task: 'feature-extraction',
      model: string,
      options: {
        revision: string;
        dtype: 'fp32' | 'q8' | 'q4';
        cache_dir: string;
        device: 'cpu';
      },
    ) => Promise<FeatureExtractor>;
    extractorPromise = createPipeline('feature-extraction', model, {
      revision,
      dtype,
      cache_dir: cacheDir,
      device: 'cpu',
    });
    await extractorPromise.then(() => {
      emitStatus(
        'pipeline-ready',
        null,
        `model=${model} revision=${revision} dtype=${dtype}`,
      );
    });
  }
  return extractorPromise;
}

function emitStatus(
  stage: string,
  requestId: number | null,
  detail: string | null,
): void {
  const payload: TransformersWorkerStatus = {
    type: 'status',
    stage,
    requestId,
    detail,
  };
  port.postMessage(payload);
  notifyControl();
  writeTransformersWorkerLog(stage, requestId, detail);
}

function notifyControl(): void {
  Atomics.store(controlState, 0, 1);
  Atomics.notify(controlState, 0);
}

function writeTransformersWorkerLog(
  stage: string,
  requestId: number | null,
  detail: string | null,
): void {
  if (
    (stage === 'embed' || stage === 'embed-completed') &&
    !shouldLogEmbeddingRequestMilestone(requestId)
  ) {
    return;
  }
  const requestPart = requestId != null ? ` request=${requestId}` : '';
  const detailPart = detail ? ` ${detail}` : '';
  process.stderr.write(
    `[transformers-embedding] ${new Date().toISOString()} stage=${stage}${requestPart}${detailPart}\n`,
  );
}

function shouldLogEmbeddingRequestMilestone(requestId: number | null): boolean {
  return requestId === 1 || (requestId != null && requestId % 100 === 0);
}

function buildRequestDetail(message: TransformersWorkerRequest): string | null {
  if (message.kind === 'warmup') {
    return `model=${model} revision=${revision} dtype=${dtype}`;
  }
  return `${String(message.text || '').length} chars`;
}
