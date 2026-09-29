/**
 * Exercise the frozen candidate through the actual plugin pipe and gateway gates.
 * The temporary model home is deleted on exit; live state is never written.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LayaRuntime } from '../../../plugins/laya-router/src/runtime.js';
import { getRuntimeConfig } from '../../../src/config/runtime-config.ts';
import { evaluateLocalClassifier } from '../../../src/gateway/local-classifier-routing.ts';
import { classifyRouting } from '../../../src/gateway/unified-routing.ts';
import {
  clearLocalClassifiers,
  registerLocalClassifier,
} from '../../../src/routing/local-classifiers.ts';

const { values } = parseArgs({
  options: {
    python: { type: 'string' },
    model: { type: 'string' },
    dataset: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.python || !values.model)
  throw new Error('Explicit local Python and checkpoint required');
const root = path.dirname(fileURLToPath(import.meta.url));
const output = values.output ?? path.join(root, 'results', 'production.jsonl');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bytes = fs.readFileSync(
  values.dataset ?? path.join(root, 'validation.json'),
);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-routing-validation-'));
fs.symlinkSync(path.resolve(values.model), path.join(home, 'model'));
const runtime = new LayaRuntime({
  home,
  component: path.resolve(root, '../../../plugins/laya-router/runtime'),
});
runtime.python = () => path.resolve(values.python);
const registration = {
  model: 'local-decision/laya',
  label: 'Laya validation',
  status: () => runtime.status(),
  command: (a) => runtime.command(a),
  predict: (i) => runtime.predict(i),
};
const fd = fs.openSync(output, 'wx');
try {
  registerLocalClassifier(registration);
  await runtime.start();
  for (const item of JSON.parse(bytes).cases) {
    const { evaluation } = await classifyRouting({
      text: item.text,
      model: registration.model,
      comparison: true,
      publicSample: true,
    });
    const three = await evaluateLocalClassifier(
      { text: item.text, comparison: true },
      registration,
      getRuntimeConfig().routing.evaluator,
      [{ name: 'basic' }, { name: 'middle' }, { name: 'advanced' }],
    );
    fs.writeSync(
      fd,
      JSON.stringify({
        id: item.id,
        expected: item.expected,
        language: item.language,
        evaluation,
        three,
      }) + '\n',
    );
  }
  fs.writeFileSync(
    output.replace(/\.jsonl$/, '.metadata.json'),
    JSON.stringify(
      {
        dataset_sha256: createHash('sha256').update(bytes).digest('hex'),
        worker_sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(runtime.component, 'worker.py')))
          .digest('hex'),
        calibration_sha256: createHash('sha256')
          .update(
            fs.readFileSync(
              path.join(runtime.component, 'routing-calibration.json'),
            ),
          )
          .digest('hex'),
        protocol:
          'Four-tier full classifyRouting and three-tier shared evaluator; identical disclosure guards, 0.8 gate; no live settings written.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  fs.closeSync(fd);
  await runtime.stop();
  clearLocalClassifiers();
  fs.rmSync(home, { recursive: true, force: true });
}
