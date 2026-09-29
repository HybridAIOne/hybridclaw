/**
 * Offline routing benchmark uses production classifiers, never executes a task.
 * Only the authored dataset is submitted; history and live settings are not changed.
 * Laya gets a separate resident worker, stopped when this process exits.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LayaRuntime } from '../../plugins/laya-router/src/runtime.js';
import { getRuntimeConfig } from '../../src/config/runtime-config.ts';
import { classifyRouting } from '../../src/gateway/unified-routing.ts';
import { registerLocalClassifier } from '../../src/routing/local-classifiers.ts';
import {
  routingTierCriteria,
  TIER_CLASSIFICATION_QUESTION,
  TIER_SELECTION_RULE,
} from '../../src/routing/policy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const bytes = fs.readFileSync(path.join(here, 'dataset.json'));
const dataset = JSON.parse(bytes);
const tiers = ['basic', 'economy', 'general', 'advanced'];
if (
  dataset.cases.length !== 200 ||
  new Set(dataset.cases.map((c) => c.text)).size !== 200
)
  throw new Error('Expected 200 unique prompts');
for (const tier of tiers)
  for (const language of ['en', 'de']) {
    if (
      dataset.cases.filter(
        (c) => c.expected === tier && c.language === language,
      ).length !== 25
    )
      throw new Error('Unbalanced dataset');
  }
const config = getRuntimeConfig().routing;
if (
  config.tiers.map((t) => t.name).join() !== tiers.join() ||
  config.maximumZone !== 'cloud'
)
  throw new Error(
    'Benchmark requires the four named tiers and cloud routing permission',
  );
const models = {
  jev: 'jev/jev-latest',
  laya: 'local-decision/laya',
  gemma: 'haigpu2/google/gemma-4-e4b-it',
};
const smoke = process.argv.includes('--smoke');
const cases = smoke
  ? [0, 50, 100, 150].map((i) => dataset.cases[i])
  : dataset.cases;
const output = path.join(
  here,
  'results',
  `${new Date().toISOString().replaceAll(':', '-')}${smoke ? '-smoke' : ''}`,
);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, 'metadata.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      datasetSha256: createHash('sha256')
        .update(JSON.stringify(dataset))
        .digest('hex'),
      models,
      count: cases.length,
      minConfidence: config.evaluator.minConfidence,
      timeoutMs: config.evaluator.timeoutMs,
      defaultStart: config.defaultStart,
      typedQuestion: TIER_CLASSIFICATION_QUESTION,
      chatInstruction: TIER_SELECTION_RULE,
      criteria: routingTierCriteria(config.tiers),
      note: 'Production classifier path and policy. Independent calls run concurrently across models, sequentially within each model. Laya startup excluded; first inference included. No retries.',
    },
    null,
    2,
  ),
);
const runtime = new LayaRuntime({
  home: path.join(os.homedir(), '.hybridclaw/laya'),
  component: path.resolve(here, '../../plugins/laya-router/runtime'),
});
registerLocalClassifier({
  model: models.laya,
  label: 'Laya benchmark',
  status: () => runtime.status(),
  command: (a) => runtime.command(a),
  predict: (i) => runtime.predict(i),
});
try {
  await runtime.start();
  for (const [index, item] of cases.entries()) {
    const batch = await Promise.all(
      Object.entries(models).map(async ([engine, model]) => {
        const { evaluation } = await classifyRouting({
          text: item.text,
          model,
          comparison: true,
          publicSample: true,
        });
        const choice =
          evaluation.distributions?.tier?.choice ?? evaluation.recommendedTier;
        const accepted =
          evaluation.status === 'evaluated' &&
          evaluation.recommendedTier !== null;
        return {
          id: item.id,
          language: item.language,
          expected: item.expected,
          engine,
          choice,
          accepted,
          effectiveTier: accepted
            ? evaluation.recommendedTier
            : config.defaultStart,
          confidence: evaluation.distributions?.tier?.confidence ?? null,
          evaluation,
        };
      }),
    );
    fs.appendFileSync(
      path.join(output, 'results.jsonl'),
      batch.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    if ((index + 1) % 10 === 0 || index + 1 === cases.length)
      console.log(`${index + 1}/${cases.length} prompts complete`);
  }
} finally {
  await runtime.stop();
}
console.log(`Results: ${output}`);
