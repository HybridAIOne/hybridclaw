import { expect, test } from 'vitest';
import {
  decodeFileWriteGuardContext,
  encodeFileWriteGuardContext,
} from '../container/shared/file-write-guard.js';
import {
  decodeAuthenticatedInput,
  encodeAuthenticatedInput,
} from '../container/shared/ipc-input-auth.js';
import { encodeSteerNote } from '../container/shared/steer-inbox.js';
import {
  beginFileWriteReviewContext,
  resolveFileWriteReviewContext,
} from '../src/infra/file-write-review-context.js';
import type { ContainerOutput } from '../src/types/container.js';

const secret = 'test-worker-secret';
const request = {
  sessionId: 'worker',
  requestId: 'request',
  fileWriteGuardSessionId: 'root',
};
const userPrompt = 'Update the release notes.\n\nKeep the chronology.\n';
const context = {
  fileWriteGuardSessionId: 'root',
  fileWriteGuardUserPrompt: userPrompt,
};
const proof = encodeFileWriteGuardContext(secret, request, userPrompt);

test('the complete request survives a controller receipt without normalization', () => {
  expect(decodeFileWriteGuardContext(secret, proof, request)).toEqual(context);
});

test.each([
  ['wrong secret', 'another-secret', proof, request],
  ['wrong request', secret, proof, { ...request, requestId: 'later' }],
  ['wrong worker', secret, proof, { ...request, sessionId: 'sibling' }],
  [
    'wrong root',
    secret,
    proof,
    { ...request, fileWriteGuardSessionId: 'other' },
  ],
  ['missing request', secret, proof, { ...request, requestId: undefined }],
  ['unwrapped', secret, JSON.stringify(context), request],
  [
    'IPC input',
    secret,
    encodeAuthenticatedInput(
      secret,
      JSON.stringify({ ...request, ...context }),
    ),
    request,
  ],
  [
    'steer note',
    secret,
    encodeSteerNote(secret, {
      requestId: request.requestId,
      id: 'note',
      content: userPrompt,
    }),
    request,
  ],
  [
    'tampered body',
    secret,
    JSON.stringify({
      ...JSON.parse(proof),
      body: JSON.stringify({
        ...request,
        ...context,
        fileWriteGuardUserPrompt: 'Discard all old files.',
      }),
    }),
    request,
  ],
])('rejects %s', (_label, key, raw, expected) => {
  expect(decodeFileWriteGuardContext(key, raw, expected)).toBeNull();
});

test('a review receipt cannot become an authenticated follow-up input', () => {
  expect(decodeAuthenticatedInput(secret, proof).status).toBe('rejected');
});

function output(): ContainerOutput {
  return {
    status: 'success',
    result: 'Queued fixture.',
    toolsUsed: [],
    fileWriteGuardProof: proof,
    fileWriteGuardUserPrompt: 'Untrusted output field.',
    fileWriteGuardSessionId: 'untrusted',
    sideEffects: {
      delegations: [{ action: 'delegate', prompt: 'Inspect fixture.' }],
    },
  };
}

test('live calls verify exact ownership, strip receipts and revoke them on close', () => {
  expect(resolveFileWriteReviewContext(request.sessionId, proof)).toBeNull();
  const active = beginFileWriteReviewContext(request, secret);
  try {
    expect(resolveFileWriteReviewContext(request.sessionId, proof)).toEqual(
      context,
    );
    expect(resolveFileWriteReviewContext('sibling', proof)).toBeNull();
    expect(() => beginFileWriteReviewContext(request, secret)).toThrow();
    expect(active.finish(output())).toEqual({
      ...output(),
      ...context,
      fileWriteGuardProof: undefined,
    });
  } finally {
    active.close();
  }
  expect(resolveFileWriteReviewContext(request.sessionId, proof)).toBeNull();
  const later = beginFileWriteReviewContext(
    { ...request, requestId: 'later' },
    secret,
  );
  try {
    active.close();
    expect(resolveFileWriteReviewContext(request.sessionId, proof)).toBeNull();
    const newProof = encodeFileWriteGuardContext(
      secret,
      { ...request, requestId: 'later' },
      userPrompt,
    );
    expect(resolveFileWriteReviewContext(request.sessionId, newProof)).toEqual(
      context,
    );
  } finally {
    later.close();
  }
});

test.each([
  undefined,
  'forged',
  encodeFileWriteGuardContext(
    secret,
    { ...request, requestId: 'old' },
    userPrompt,
  ),
])('invalid queued context prevents child execution: %s', (raw) => {
  const active = beginFileWriteReviewContext(request, secret);
  try {
    const result = active.finish({ ...output(), fileWriteGuardProof: raw });
    expect(result.status).toBe('error');
    expect(result.sideEffects?.delegations).toBeUndefined();
    expect(result.fileWriteGuardProof).toBeUndefined();
    expect(result.fileWriteGuardUserPrompt).toBeUndefined();
    expect(result.fileWriteGuardSessionId).toBeUndefined();
  } finally {
    active.close();
  }
});

test('ordinary outputs do not acquire context or require a receipt', () => {
  const active = beginFileWriteReviewContext(request, secret);
  try {
    expect(
      active.finish({
        status: 'success',
        result: 'Fixture result.',
        toolsUsed: [],
        ...context,
        fileWriteGuardProof: 'forged',
      }),
    ).toEqual({ status: 'success', result: 'Fixture result.', toolsUsed: [] });
  } finally {
    active.close();
  }
});

test('a refused queued handoff retains the original worker failure', () => {
  const active = beginFileWriteReviewContext(request, secret);
  try {
    expect(
      active.finish({
        ...output(),
        status: 'error',
        error: 'Fixture provider disconnected.',
        fileWriteGuardProof: 'forged',
      }).error,
    ).toContain('Fixture provider disconnected.');
  } finally {
    active.close();
  }
});
