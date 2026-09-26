/**
 * Blocking Transformers.js embedding provider for HybridClaw built-in memory.
 *
 * Semantic memory embeds synchronously, so each request is posted to a worker
 * thread (worker.js) and the caller parks on a SharedArrayBuffer until the
 * worker answers or the request times out. There is no fallback to another
 * provider: a failed request throws.
 */
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
} from 'node:worker_threads';

const WORKER_POLL_INTERVAL_MS = 50;
const WORKER_REQUEST_TIMEOUT_MS = 120_000;
export class TransformersJsEmbeddingProvider {
  runtime;
  model;
  constructor(options, runtime) {
    this.model = options.model;
    this.runtime =
      runtime || new PollingWorkerTransformersEmbeddingRuntime(options);
  }
  embedQuery(text) {
    const normalized = text.trim();
    if (!normalized) return null;
    return this.runtime.embed(
      buildTransformersEmbeddingInput(normalized, 'query', this.model),
    );
  }
  embedDocument(text) {
    const normalized = text.trim();
    if (!normalized) return null;
    return this.runtime.embed(
      buildTransformersEmbeddingInput(normalized, 'document', this.model),
    );
  }
  warmup() {
    this.runtime.warmup?.();
  }
  dispose() {
    this.runtime.dispose?.();
  }
}
class PollingWorkerTransformersEmbeddingRuntime {
  options;
  pollIntervalMs;
  timeoutMs;
  worker = null;
  port = null;
  control = null;
  nextRequestId = 1;
  lastStatus = null;
  lastWorkerError = null;
  lastWorkerExitCode = null;
  shuttingDown = false;
  constructor(options) {
    this.options = options;
    this.pollIntervalMs = WORKER_POLL_INTERVAL_MS;
    this.timeoutMs = WORKER_REQUEST_TIMEOUT_MS;
  }
  warmup() {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.options.logger.info(
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
    this.options.logger.info(
      {
        requestId,
        model: this.options.model,
      },
      'Transformers.js embedding warmup completed',
    );
  }
  embed(text) {
    const normalized = text.trim();
    if (!normalized) return null;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    if (shouldLogEmbeddingRequestMilestone(requestId)) {
      this.options.logger.info(
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
      this.options.logger.info(
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
  dispose() {
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
  ensureWorker() {
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
    this.options.logger.info(
      {
        model: this.options.model,
        revision: this.options.revision,
        dtype: this.options.dtype,
        cacheDir: this.options.cacheDir,
      },
      'Starting Transformers.js embedding worker',
    );
    const worker = new Worker(this.options.workerUrl, {
      workerData: {
        model: this.options.model,
        revision: this.options.revision,
        dtype: this.options.dtype,
        cacheDir: this.options.cacheDir,
        control: controlBuffer,
        port: port2,
      },
      transferList: [port2],
    });
    worker.on('online', () => {
      this.options.logger.info(
        { model: this.options.model },
        'Transformers.js embedding worker is online',
      );
    });
    worker.on('error', (error) => {
      this.lastWorkerError = error;
      this.options.logger.error(
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
        this.options.logger.info(
          { model: this.options.model, exitCode: code },
          'Transformers.js embedding worker exited',
        );
      } else {
        this.options.logger.error(
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
  sendRequest(params) {
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
      const message = packet?.message;
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
  recordWorkerStatus(message) {
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
      this.options.logger.info(
        logPayload,
        'Transformers.js embedding worker status',
      );
      return;
    }
    this.options.logger.debug(
      logPayload,
      'Transformers.js embedding worker status',
    );
  }
}
function shouldLogEmbeddingRequestMilestone(requestId) {
  return requestId === 1 || (requestId != null && requestId % 100 === 0);
}
function isWorkerStatusMessage(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'status'
  );
}
function formatTransformersEmbeddingTimeoutMessage(params) {
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
function buildTransformersEmbeddingInput(text, kind, model) {
  if (!isEmbeddingGemmaModel(model)) {
    return text;
  }
  if (kind === 'query') {
    return `task: search result | query: ${text}`;
  }
  return `title: none | text: ${text}`;
}
function isEmbeddingGemmaModel(model) {
  return model.toLowerCase().includes('embeddinggemma');
}
