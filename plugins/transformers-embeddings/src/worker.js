// Worker thread for provider.js: owns the Transformers.js pipeline and answers
// one request at a time, waking the blocked caller through the shared control
// word after every status and result message.
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

const { model, revision, dtype, cacheDir, control, port } = workerData;
const controlState = new Int32Array(control);
let extractorPromise = null;
if (!parentPort) {
  throw new Error('Transformers embedding worker requires a parent port.');
}
env.cacheDir = cacheDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;
emitStatus('worker-started', null, `model=${model} dtype=${dtype}`);
parentPort.on('message', (message) => {
  void handleRequest(message);
});
async function handleRequest(message) {
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
    extractorPromise = pipeline('feature-extraction', model, {
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
function emitStatus(stage, requestId, detail) {
  const payload = {
    type: 'status',
    stage,
    requestId,
    detail,
  };
  port.postMessage(payload);
  notifyControl();
  writeTransformersWorkerLog(stage, requestId, detail);
}
function notifyControl() {
  Atomics.store(controlState, 0, 1);
  Atomics.notify(controlState, 0);
}
function writeTransformersWorkerLog(stage, requestId, detail) {
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
function shouldLogEmbeddingRequestMilestone(requestId) {
  return requestId === 1 || (requestId != null && requestId % 100 === 0);
}
function buildRequestDetail(message) {
  if (message.kind === 'warmup') {
    return `model=${model} revision=${revision} dtype=${dtype}`;
  }
  return `${String(message.text || '').length} chars`;
}
