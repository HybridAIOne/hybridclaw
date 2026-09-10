/** Reproducible synthetic boundary checks against an explicitly selected local installation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function checkLive(home) {
  const profile = JSON.parse(
    fs.readFileSync(path.join(home, 'installation.json'), 'utf8'),
  );
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  const base = `http://127.0.0.1:${profile.port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const task = randomUUID();
  const messages = [
    {
      role: 'system',
      content: 'You are concise. Keep all answers short. '.repeat(32),
    },
    { role: 'user', content: 'Say hello.' },
  ];
  const chat = (
    body = {},
    scope = task,
    signal = AbortSignal.timeout(120_000),
  ) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { ...headers, 'X-HybridClaw-Task': scope },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 16,
        messages,
        ...body,
      }),
    });
  const checks = {};
  checks.unauthorized = (await fetch(`${base}/health`)).status === 401;
  checks.browserBlocked =
    (
      await fetch(`${base}/health`, {
        headers: { ...headers, Origin: 'https://example.com' },
      })
    ).status === 401;
  checks.modelPin = (await chat({ model: 'other-model' })).status === 400;
  checks.outputBudget =
    (await chat({ max_tokens: profile.contextWindow + 1 })).status === 400;
  checks.remoteCode = (await chat({ adapters: 'remote/model' })).status === 400;
  await (await chat()).json();
  const cached = await (
    await chat({
      messages: [messages[0], { role: 'user', content: 'Say goodbye.' }],
    })
  ).json();
  const separate = await (await chat({}, randomUUID())).json();
  checks.sameTaskCache =
    (cached.usage?.prompt_tokens_details?.cached_tokens || 0) > 0;
  checks.separateTaskCache =
    (separate.usage?.prompt_tokens_details?.cached_tokens || 0) === 0;
  const stream = await chat(
    {
      stream: true,
      max_tokens: profile.contextWindow,
      messages: [
        { role: 'user', content: 'Write a long story about a garden.' },
      ],
    },
    randomUUID(),
  );
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  checks.singleAdmission = (await chat()).status === 429;
  const start = Date.now();
  await reader.cancel();
  checks.cancelAndRecover = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    const response = await chat({}, randomUUID());
    if (response.ok) {
      await response.text();
      checks.cancelAndRecover = true;
      break;
    }
    await response.body?.cancel();
  }
  const cancelRecoveryMs = Date.now() - start;
  const cancellation = new AbortController();
  const pending = chat(
    {
      max_tokens: profile.contextWindow,
      messages: [
        { role: 'user', content: 'Write a long story about a forest.' },
      ],
    },
    randomUUID(),
    cancellation.signal,
  ).catch(() => null);
  await delay(500);
  assert.equal(
    (await chat()).status,
    429,
    'Non-streaming request must be active before cancellation',
  );
  cancellation.abort();
  await pending;
  checks.nonStreamingCancelAndRecover = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    const response = await chat({}, randomUUID());
    if (response.ok) {
      await response.text();
      checks.nonStreamingCancelAndRecover = true;
      break;
    }
    await response.body?.cancel();
  }
  checks.contextOverflow =
    (
      await chat({
        messages: [
          {
            role: 'user',
            content: 'hello '.repeat(profile.contextWindow + 64),
          },
        ],
      })
    ).status === 400;
  const healthResponse = await fetch(`${base}/health`, { headers });
  checks.health = healthResponse.status === 200;
  const report = {
    timestamp: new Date().toISOString(),
    model: profile.model,
    revision: profile.revision,
    cancelRecoveryMs,
    checks,
    health: await healthResponse.json(),
  };
  fs.writeFileSync(
    path.join(home, 'boundary-check.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  for (const [name, passed] of Object.entries(checks))
    assert.equal(passed, true, name);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.ok(process.argv[2], 'Usage: node check_live.mjs <installation-home>');
  console.log(
    JSON.stringify(await checkLive(path.resolve(process.argv[2])), null, 2),
  );
}
