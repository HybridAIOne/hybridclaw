/**
 * Fixed JEV/Gemma references on the authored holdout through production routing.
 * No local runtime starts and only public synthetic prompts leave this process.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getRuntimeConfig } from '../../../src/config/runtime-config.ts';
import { classifyRouting } from '../../../src/gateway/unified-routing.ts';
import {
  routingTierCriteria,
  TIER_CLASSIFICATION_QUESTION,
  TIER_SELECTION_RULE,
} from '../../../src/routing/policy.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: path.join(root, 'holdout.json') },
    output: { type: 'string', default: path.join(root, 'results') },
  },
});
const bytes = fs.readFileSync(values.dataset);
const { cases } = JSON.parse(bytes);
const config = getRuntimeConfig().routing;
const output = values.output;
fs.mkdirSync(output, { recursive: true });
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(root, '../results/2026-09-29T17-32-52.218Z/metadata.json'),
    'utf8',
  ),
);
if (
  JSON.stringify(routingTierCriteria(config.tiers)) !==
  JSON.stringify(baseline.criteria)
)
  throw new Error(
    'Production tier criteria differ from frozen comparison criteria',
  );
const models = {
  jev: 'jev/jev-latest',
  gemma: 'haigpu2/google/gemma-4-e4b-it',
};
fs.writeFileSync(
  path.join(output, 'remote.metadata.json'),
  JSON.stringify(
    {
      models,
      criteria: baseline.criteria,
      typedQuestion: TIER_CLASSIFICATION_QUESTION,
      chatInstruction: TIER_SELECTION_RULE,
      dataset_sha256: createHash('sha256').update(bytes).digest('hex'),
      policy: {
        minConfidence: config.evaluator.minConfidence,
        timeoutMs: config.evaluator.timeoutMs,
        defaultStart: config.defaultStart,
      },
      protocol:
        'Production routing; fixed prompts and configured timeout/gate; no retries. Gemma returns a label, not comparable native probabilities.',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
const fd = fs.openSync(path.join(output, 'remote.jsonl'), 'wx');
try {
  for (const [i, item] of cases.entries()) {
    const rows = await Promise.all(
      Object.entries(models).map(async ([engine, model]) => {
        const { evaluation } = await classifyRouting({
          text: item.text,
          model,
          comparison: true,
          publicSample: true,
        });
        const choice =
          evaluation.distributions?.tier?.choice ?? evaluation.recommendedTier;
        return {
          id: item.id,
          language: item.language,
          expected: item.expected,
          engine,
          choice,
          correct: choice === item.expected,
          accepted:
            evaluation.status === 'evaluated' &&
            evaluation.recommendedTier !== null,
          evaluation,
        };
      }),
    );
    fs.writeSync(fd, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${cases.length}`);
  }
} finally {
  fs.closeSync(fd);
}
