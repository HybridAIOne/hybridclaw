import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from 'node:worker_threads';

import { logger } from '../logger.js';
import type {
  MemoryEmbeddingDtype,
  MemoryEmbeddingInputKind,
} from './embeddings.js';
import type { EmbeddingProvider } from './memory-service.js';

const WORKER_POLL_INTERVAL_MS = 50;
const WORKER_REQUEST_TIMEOUT_MS = 120_000;

interface TransformersWorkerRequest {
  requestId: number;
  kind: 'embed' | 'warmup';
  text?: string;
}

interface TransformersWorkerSuccess {
  requestId: number;
  ok: true;
  embedding: number[] | null;
}

interface TransformersWorkerFailure {
  requestId: number;
  ok: false;
  error: string;
}

interface TransformersWorkerStatus {
  type: 'status';
  stage: string;
  requestId: number | null;
  detail: string | null;
}

type TransformersWorkerResponse =
  | TransformersWorkerSuccess
  | TransformersWorkerFailure
  | TransformersWorkerStatus;

export interface BlockingEmbeddingRuntime {
  embed(text: string): number[] | null;
  warmup?(): void;
  dispose?(): void;
}

export interface TransformersJsEmbeddingProviderOptions {
  model: string;
  revision: string;
  dtype: MemoryEmbeddingDtype;
  cacheDir: string;
}

interface WorkerBootstrapData extends TransformersJsEmbeddingProviderOptions {
  control: SharedArrayBuffer;
  port: MessagePort;
}

interface WorkerStatusSnapshot {
  stage: string;
  requestId: number | null;
  detail: string | null;
  at: string;
}

const transformersEmbeddingLogger =
  'child' in logger && typeof logger.child === 'function'
    ? logger.child({
        component: 'transformers-embedding',
      })
    : logger;

export class TransformersJsEmbeddingProvider implements EmbeddingProvider {
  private readonly runtime: BlockingEmbeddingRuntime;
  private readonly model: string;

  constructor(
    options: TransformersJsEmbeddingProviderOptions,
    runtime?: BlockingEmbeddingRuntime,
  ) {
    this.model = options.model;
    this.runtime =
      runtime || new PollingWorkerTransformersEmbeddingRuntime(options);
  }

  embedQuery(text: string): number[] | null {
    const normalized = text.trim();
    if (!normalized) return null;
    return this.runtime.embed(
      buildTransformersEmbeddingInput(normalized, 'query', this.model),
    );
  }

  embedDocument(text: string): number[] | null {
    const normalized = text.trim();
    if (!normalized) return null;
    return this.runtime.embed(
      buildTransformersEmbeddingInput(normalized, 'document', this.model),
    );
  }

  warmup(): void {
    this.runtime.warmup?.();
  }

  dispose(): void {
    this.runtime.dispose?.();
  }
}

class PollingWorkerTransformersEmbeddingRuntime
  implements BlockingEmbeddingRuntime
{
  private readonly options: TransformersJsEmbeddingProviderOptions;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private control: Int32Array | null = null;
  private nextRequestId = 1;
  private lastStatus: WorkerStatusSnapshot | null = null;
  private lastWorkerError: Error | null = null;
  private lastWorkerExitCode: number | null = null;
  private shuttingDown = false;

  constructor(options: TransformersJsEmbeddingProviderOptions) {
    this.options = options;
    this.pollIntervalMs = WORKER_POLL_INTERVAL_MS;
    this.timeoutMs = WORKER_REQUEST_TIMEOUT_MS;
  }

  warmup(): void {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    transformersEmbeddingLogger.info(
      {
        requestId,
        model: this.options.model,
        revision: this.options.revision,
        dtype: this.options.dtype,
      },
      'Transformers.js embedding warmup started',
    );
    this.sendRequest({
      requestId,
      request: {
        requestId,
        kind: 'warmup',
      },
      detailForError: {
        requestKind: 'warmup',
        textLength: null,
      },
    });
    transformersEmbeddingLogger.info(
      {
        requestId,
        model: this.options.model,
      },
      'Transformers.js embedding warmup completed',
    );
  }

  embed(text: string): number[] | null {
    const normalized = text.trim();
    if (!normalized) return null;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    if (shouldLogEmbeddingRequestMilestone(requestId)) {
      transformersEmbeddingLogger.info(
        {
          requestId,
          model: this.options.model,
          textLength: normalized.length,
        },
        'Transformers.js embedding request started',
      );
    }

    const embedding = this.sendRequest({
      requestId,
      request: {
        requestId,
        kind: 'embed',
        text: normalized,
      },
      detailForError: {
        requestKind: 'embed',
        textLength: normalized.length,
      },
    });

    if (shouldLogEmbeddingRequestMilestone(requestId)) {
      transformersEmbeddingLogger.info(
        {
          requestId,
          model: this.options.model,
          textLength: normalized.length,
        },
        'Transformers.js embedding request completed',
      );
    }
    return embedding;
  }

  dispose(): void {
    this.shuttingDown = true;
    this.port?.close();
    this.port = null;
    void this.worker?.terminate();
    this.worker = null;
    this.control = null;
    this.lastStatus = null;
    this.lastWorkerError = null;
    this.lastWorkerExitCode = null;
  }

  private ensureWorker(): {
    worker: Worker;
    port: MessagePort;
    control: Int32Array;
  } {
    if (this.worker && this.port && this.control) {
      return {
        worker: this.worker,
        port: this.port,
        control: this.control,
      };
    }

    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const control = new Int32Array(controlBuffer);
    const { port1, port2 } = new MessageChannel();
    this.shuttingDown = false;
    transformersEmbeddingLogger.info(
      {
        model: this.options.model,
        revision: this.options.revision,
        dtype: this.options.dtype,
        cacheDir: this.options.cacheDir,
      },
      'Starting Transformers.js embedding worker',
    );
    const worker = new Worker(buildWorkerModuleUrl(), {
      workerData: {
        ...this.options,
        control: controlBuffer,
        port: port2,
      } satisfies WorkerBootstrapData,
      transferList: [port2],
    });
    worker.on('online', () => {
      transformersEmbeddingLogger.info(
        { model: this.options.model },
        'Transformers.js embedding worker is online',
      );
    });
    worker.on('error', (error) => {
      this.lastWorkerError = error;
      transformersEmbeddingLogger.error(
        { err: error, model: this.options.model },
        'Transformers.js embedding worker error',
      );
      if (this.control) {
        Atomics.store(this.control, 0, 1);
        Atomics.notify(this.control, 0);
      }
    });
    worker.on('exit', (code) => {
      if (this.shuttingDown) {
        return;
      }
      this.lastWorkerExitCode = code;
      if (code === 0) {
        transformersEmbeddingLogger.info(
          { model: this.options.model, exitCode: code },
          'Transformers.js embedding worker exited',
        );
      } else {
        transformersEmbeddingLogger.error(
          { model: this.options.model, exitCode: code },
          'Transformers.js embedding worker exited unexpectedly',
        );
      }
      if (this.control) {
        Atomics.store(this.control, 0, 1);
        Atomics.notify(this.control, 0);
      }
    });

    this.worker = worker;
    this.port = port1;
    this.control = control;
    this.lastWorkerError = null;
    this.lastWorkerExitCode = null;

    return {
      worker,
      port: port1,
      control,
    };
  }

  private sendRequest(params: {
    requestId: number;
    request: TransformersWorkerRequest;
    detailForError: {
      requestKind: 'embed' | 'warmup';
      textLength: number | null;
    };
  }): number[] | null {
    const { worker, port, control } = this.ensureWorker();

    Atomics.store(control, 0, 0);
    worker.postMessage(params.request);

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      if (this.lastWorkerError) {
        const error = this.lastWorkerError;
        this.lastWorkerError = null;
        throw new Error(
          `Transformers.js embedding worker failed for ${this.options.model}: ${error.message}`,
        );
      }
      if (this.lastWorkerExitCode !== null) {
        const exitCode = this.lastWorkerExitCode;
        this.lastWorkerExitCode = null;
        throw new Error(
          `Transformers.js embedding worker exited with code ${exitCode} for ${this.options.model}. Check eval logs for [transformers-embedding] diagnostics.`,
        );
      }

      const packet = receiveMessageOnPort(port);
      const message = packet?.message as TransformersWorkerResponse | undefined;
      if (message && isWorkerStatusMessage(message)) {
        this.recordWorkerStatus(message);
        continue;
      }
      if (
        message &&
        'requestId' in message &&
        message.requestId === params.requestId
      ) {
        if (!message.ok) {
          throw new Error(message.error);
        }
        return message.embedding;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      Atomics.wait(control, 0, 0, Math.min(this.pollIntervalMs, remainingMs));
    }

    throw new Error(
      formatTransformersEmbeddingTimeoutMessage({
        timeoutMs: this.timeoutMs,
        model: this.options.model,
        requestId: params.requestId,
        requestKind: params.detailForError.requestKind,
        textLength: params.detailForError.textLength,
        lastStatus: this.lastStatus,
      }),
    );
  }

  private recordWorkerStatus(message: TransformersWorkerStatus): void {
    this.lastStatus = {
      stage: message.stage,
      requestId: message.requestId,
      detail: message.detail,
      at: new Date().toISOString(),
    };
    const logPayload = {
      model: this.options.model,
      stage: message.stage,
      requestId: message.requestId,
      detail: message.detail,
    };
    if (
      message.stage === 'worker-started' ||
      message.stage === 'pipeline-loading' ||
      message.stage === 'pipeline-ready' ||
      message.stage === 'warmup' ||
      message.stage === 'warmup-completed' ||
      message.stage === 'request-failed' ||
      ((message.stage === 'embed' || message.stage === 'embed-completed') &&
        shouldLogEmbeddingRequestMilestone(message.requestId))
    ) {
      transformersEmbeddingLogger.info(
        logPayload,
        'Transformers.js embedding worker status',
      );
      return;
    }
    transformersEmbeddingLogger.debug(
      logPayload,
      'Transformers.js embedding worker status',
    );
  }
}

function shouldLogEmbeddingRequestMilestone(
  requestId: number | null | undefined,
): boolean {
  return requestId === 1 || (requestId != null && requestId % 100 === 0);
}

function isWorkerStatusMessage(
  value: TransformersWorkerResponse,
): value is TransformersWorkerStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'status'
  );
}

function formatTransformersEmbeddingTimeoutMessage(params: {
  timeoutMs: number;
  model: string;
  requestId: number;
  requestKind: 'embed' | 'warmup';
  textLength: number | null;
  lastStatus: WorkerStatusSnapshot | null;
}): string {
  const lastStatus = params.lastStatus
    ? ` Last worker status: ${params.lastStatus.stage}${
        params.lastStatus.requestId != null
          ? ` (request ${params.lastStatus.requestId})`
          : ''
      }${params.lastStatus.detail ? ` - ${params.lastStatus.detail}` : ''}.`
    : '';
  const requestDescription =
    params.requestKind === 'warmup'
      ? `warmup request ${params.requestId}`
      : `request ${params.requestId}, ${params.textLength || 0} chars`;
  return `Transformers.js embedding request timed out after ${params.timeoutMs}ms for model ${params.model} (${requestDescription}).${lastStatus} Check eval logs for [transformers-embedding] diagnostics.`;
}

function buildTransformersEmbeddingInput(
  text: string,
  kind: MemoryEmbeddingInputKind,
  model: string,
): string {
  if (!isEmbeddingGemmaModel(model)) {
    return text;
  }
  if (kind === 'query') {
    return `task: search result | query: ${text}`;
  }
  return `title: none | text: ${text}`;
}

function isEmbeddingGemmaModel(model: string): boolean {
  return model.toLowerCase().includes('embeddinggemma');
}

function isSourceTsWorker(): boolean {
  return path.extname(fileURLToPath(import.meta.url)) === '.ts';
}

function buildWorkerModuleUrl(): URL {
  if (isSourceTsWorker()) {
    return new URL(
      './transformers-embedding-worker-bootstrap.mjs',
      import.meta.url,
    );
  }
  return new URL('./transformers-embedding-worker.js', import.meta.url);
}
