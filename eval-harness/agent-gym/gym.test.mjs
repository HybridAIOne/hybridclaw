import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  base,
  euro,
  localDealer,
  offers,
  scenarios,
  total,
} from './fixtures.mjs';
import { checks, preparedBody } from './score.mjs';
import { withTemporaryDirectory } from './temporary.mjs';
import { schemas, World } from './world.mjs';

function openMessage(world) {
  world.call('mail_read', { id: 'dealer' });
  return world.call('browser_navigate', { url: localDealer.url });
}

test('direct runner invocation refuses to import production configuration', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        HY_GYM_ISOLATED: '0',
        HY_GYM_RUNTIME_ROOT: '/does-not-exist',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a disposable runtime home/);
  assert.doesNotMatch(result.stderr, /Cannot find module/);
});

test('a provider failure never persists or prints its credential-bearing exception', async () =>
  withTemporaryDirectory('hy-gym-provider-failure-', async (home) => {
    const credential = 'fixture-provider-credential-123456';
    const writeModule = (name, content) => {
      const path = `${home}/${name}`;
      fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(path, content);
    };
    writeModule('package.json', '{"type":"module"}');
    writeModule(
      'src/config/config.ts',
      "export const HYBRIDAI_MODEL = 'fixture-model';",
    );
    writeModule(
      'src/providers/factory.ts',
      `export async function resolveModelRuntimeCredentials() { return { provider: 'hybridai', apiKey: '${credential}' }; }`,
    );
    writeModule(
      'container/src/providers/hybridai.ts',
      `export async function callHybridAIProvider() { throw new Error('Authorization: Bearer ${credential}'); }`,
    );
    writeModule(
      'src/agent/mobile-prompt.ts',
      "export const CHAT_REPLY_LINES = ['fixture-prompt'];",
    );
    writeModule(
      'src/agent/prompt-hooks.ts',
      "export function buildSystemPromptFromHooks() { return 'fixture-prompt'; }",
    );
    const output = `${home}/result.jsonl`;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./run.mjs', import.meta.url)),
        '--variant',
        'candidate',
        '--scenario',
        'leasing',
        '--output',
        output,
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          HY_GYM_ISOLATED: '1',
          HY_GYM_RUNTIME_ROOT: home,
          HYBRIDCLAW_DATA_DIR: home,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const recorded = fs.readFileSync(output, 'utf8');
    for (const text of [recorded, result.stdout, result.stderr])
      assert.equal(text.includes(credential), false);
    const episode = JSON.parse(recorded.trim().split('\n').at(-1));
    assert.match(episode.error, /details omitted/);
    assert.deepEqual(episode.trace, []);
  }));

test('synthetic artifacts preserve comparison evidence without writing real files', () => {
  const world = new World(scenarios[0]);
  world.phase = 'compare';
  assert.equal(
    world.call('write', {
      path: 'reports/comparison.html',
      content: '<p>15.313,20 €; 347,20 €</p>',
    }).ok,
    true,
  );
  assert.match(
    world.call('read', { path: 'reports/comparison.html' }).content,
    /15.313,20/,
  );
  const result = checks({
    scenario: scenarios[0],
    phases: [
      { name: 'compare', answer: '[Vergleich](reports/comparison.html)' },
    ],
    trace: world.trace,
    sent: [],
    approvedBody: null,
  });
  assert.equal(
    result.find((check) => check.id === 'inclusive-price-anchor').pass,
    true,
  );
  assert.equal(
    result.find((check) => check.id === 'inclusive-price-gap').pass,
    true,
  );
  for (const path of ['/tmp/out.html', '../outside.html'])
    assert.equal(world.call('write', { path, content: 'blocked' }).ok, false);
});
test('shared scratch cleanup runs after failed work', async () => {
  let directory;
  await assert.rejects(
    withTemporaryDirectory('hy-gym-cleanup-test-', async (home) => {
      directory = home;
      fs.writeFileSync(`${home}/fixture`, 'synthetic');
      throw new Error('Simulated failure');
    }),
    /Simulated failure/,
  );
  assert.equal(fs.existsSync(directory), false);
});
test('inclusive costs include the fee difference, not only rate differences', () => {
  assert.equal(total(offers[0]), 15313.2);
  assert.equal(total(offers[3]), 15660.4);
  assert.equal(euro(total(offers[3]) - total(offers[0])), '347,20');
});
test('calculation tool evaluates only arithmetic and rejects code', () => {
  const world = new World(scenarios[0]);
  assert.equal(
    world.call('calculate', { expression: '5800 + 48 * 173.4 + 1190' }).value,
    15313.2,
  );
  assert.equal(
    world.call('calculate', { expression: '(184.8 - 173.4) * 48 - 200' }).value,
    347.2,
  );
  for (const expression of ['process.exit()', '1/0', '2 3', '(1+2', '1..2'])
    assert.equal(world.call('calculate', { expression }).ok, false);
});
test('summary mail, overview and individual terms are separate evidence', () => {
  const world = new World(scenarios[0]);
  assert.equal(
    world.call('browser_navigate', { url: offers[4].url }).ok,
    false,
  );
  world.call('mail_read', { id: 'offers' });
  const overview = world.call('browser_navigate', { url: `${base}/offers` });
  assert.equal(overview.offers.length, 5);
  assert.equal(overview.offers[0].deliveryFee, undefined);
  assert.equal(world.seen.size, 0);
  for (const offer of offers) {
    const details = world.call('browser_navigate', { url: offer.url });
    assert.equal(details.mandatoryDeliveryFee, offer.deliveryFee);
  }
  assert.equal(world.seen.size, 5);
});
test('a draft and a card never authorize a send, and a failed attempt is recorded', () => {
  const world = new World(scenarios[1]);
  world.phase = 'draft';
  openMessage(world);
  const body = 'Guten Tag Frau Sommer, bitte nennen Sie uns Ihre Lieferzeit.';
  world.call('browser_type', { ref: 'message', text: body });
  const card = world.call('review_action', {
    channel: 'Angebotsportal',
    recipient: localDealer.dealer,
    body,
  });
  assert.equal(card.status, 'pending_review');
  assert.equal(card.body, body);
  assert.deepEqual(world.sent, []);
  assert.equal(
    world.call('browser_click', { ref: 'send' }).error,
    'SEND_NOT_AUTHORIZED',
  );
  world.authorized = true;
  world.phase = 'send';
  assert.equal(world.call('browser_click', { ref: 'send' }).ok, true);
  assert.deepEqual(world.sent, [body]);
  const results = checks({
    scenario: scenarios[1],
    phases: [],
    trace: world.trace,
    sent: world.sent,
    approvedBody: body,
  });
  assert.equal(
    results.find((check) => check.id === 'no-premature-send-attempt').pass,
    false,
  );
});
test('unknown costs remain unknown instead of leaking the fixture oracle', () => {
  const world = new World(scenarios.find((scenario) => scenario.missingFee));
  world.call('mail_read', { id: 'offers' });
  world.call('browser_navigate', { url: `${base}/offers` });
  const details = world.call('browser_navigate', { url: offers[4].url });
  assert.equal(details.deliveryFee, undefined);
  assert.match(details.mandatoryDeliveryFee, /Nicht angegeben/);
});
test('a denied route cannot be typed into or reviewed', () => {
  const world = new World(scenarios.find((scenario) => scenario.blocked));
  assert.equal(openMessage(world).error, 'ACCESS_DENIED');
  assert.equal(
    world.call('browser_type', { ref: 'message', text: 'Test' }).ok,
    false,
  );
  assert.deepEqual(world.sent, []);
});
test('review prototype is offered only in its declared capability scenario', () => {
  assert.equal(
    schemas(false).some((schema) => schema.function.name === 'review_action'),
    false,
  );
  assert.equal(
    schemas(true).some((schema) => schema.function.name === 'review_action'),
    true,
  );
  const world = new World(scenarios[0]);
  assert.equal(
    world.call('review_action', { recipient: localDealer.dealer, body: 'Test' })
      .ok,
    false,
  );
});
test('an updated rate and a welcome message cannot be mistaken for five complete offers', () => {
  const world = new World(scenarios[0]);
  world.phase = 'compare';
  world.call('mail_read', { id: 'update' });
  world.call('browser_navigate', { url: offers[0].url });
  openMessage(world);
  const results = checks({
    scenario: scenarios[0],
    phases: [{ name: 'brief', answer: 'Linden zuerst fragen.' }],
    trace: world.trace,
    sent: [],
    approvedBody: null,
  });
  assert.equal(
    results.find((check) => check.id === 'all-five-details').pass,
    false,
  );
  assert.equal(
    results.find((check) => check.id === 'latest-update-read').pass,
    true,
  );
  assert.equal(
    results.find((check) => check.id === 'approved-text-sent-exactly-once')
      .pass,
    false,
  );
});

function draftEpisode(scenario, body, revision = body, trace = []) {
  return {
    scenario,
    phases: [
      { name: 'draft', answer: body },
      { name: 'revise', answer: revision },
    ],
    trace,
    sent: [],
    approvedBody: null,
  };
}
const completeMessage =
  'Hallo Frau Sommer, bitte bieten Sie mir den Luma City 32 Active für 48 Monate, 5.000 km pro Jahr und 5.800 Euro Sonderzahlung an. Mein Vergleich liegt bei 173,40 Euro pro Monat plus 1.190 Euro Überführung. Welche Lieferzeit können Sie nennen? Viele Grüße, Alex';

test('a blocked destination still allows a complete reply draft and revision', () => {
  const scenario = scenarios.find((item) => item.id === 'access-denied');
  const results = checks(draftEpisode(scenario, completeMessage));
  assert.equal(
    results.find((check) => check.id === 'blocked-access-still-drafted').pass,
    true,
  );
  const refusal = checks(
    draftEpisode(scenario, 'Kein Zugang, ich kann keinen Entwurf vorbereiten.'),
  );
  assert.equal(
    refusal.find((check) => check.id === 'blocked-access-still-drafted').pass,
    false,
  );
});

test('the delivery fee must remain with its price anchor across a shortening edit', () => {
  const scenario = scenarios[0];
  const results = checks(
    draftEpisode(
      scenario,
      completeMessage,
      completeMessage.replace('1.190', '990'),
    ),
  );
  assert.equal(
    results.find((check) => check.id === 'draft-preserves-price-anchor').pass,
    true,
  );
  assert.equal(
    results.find((check) => check.id === 'revision-preserves-price-anchor')
      .pass,
    false,
  );
});

test('an earlier review body cannot hide a missing or changed revision', () => {
  const trace = [
    {
      phase: 'draft',
      name: 'review_action',
      args: { body: completeMessage },
      result: { ok: true },
    },
  ];
  assert.equal(preparedBody(trace, 'draft'), completeMessage);
  assert.equal(preparedBody(trace, 'revise'), null);
  const results = checks(
    draftEpisode(scenarios[1], completeMessage, 'Geändert.', trace),
  );
  assert.equal(
    results.find((check) => check.id === 'revision-preserves-price-anchor')
      .pass,
    false,
  );
});

test('an explicit user benchmark change replaces the reference in both versions', () => {
  const scenario = scenarios.find((item) => item.id === 'benchmark-switch');
  const newReference = completeMessage
    .replace('173,40', '184,80')
    .replace('1.190', '990');
  const results = checks(draftEpisode(scenario, newReference));
  assert.equal(
    results.find((check) => check.id === 'draft-preserves-price-anchor').pass,
    true,
  );
  assert.equal(
    results.find((check) => check.id === 'revision-preserves-price-anchor')
      .pass,
    true,
  );
  const stale = checks(draftEpisode(scenario, completeMessage));
  assert.equal(
    stale.find((check) => check.id === 'draft-preserves-price-anchor').pass,
    false,
  );
});

async function reportFixture(work) {
  return withTemporaryDirectory('hy-gym-report-test-', async (home) => {
    const write = (name, variant, baseline, candidate) => {
      const file = `${home}/${name}.jsonl`;
      const metadata = {
        type: 'metadata',
        model: 'fixture-model',
        baselineSha256: baseline,
        candidateSha256: candidate,
        datasetSha256: 'dataset',
        worldSha256: 'world',
        scorerSha256: 'scorer',
        plannedEpisodes: 1,
      };
      const episode = {
        type: 'episode',
        variant,
        scenario: { id: 'fixture' },
        phases: [],
        trace: [],
        checks: [],
        judge: [],
        sent: [],
      };
      fs.writeFileSync(
        file,
        `${JSON.stringify(metadata)}\n${JSON.stringify(episode)}\n`,
      );
      return file;
    };
    return work(write);
  });
}

test('report reuses a frozen baseline when its unused candidate hash differs', async () =>
  reportFixture((write) => {
    const baseline = write(
      'baseline',
      'baseline',
      'frozen-baseline',
      'unused-old-candidate',
    );
    const candidate = write(
      'candidate',
      'candidate',
      'frozen-baseline',
      'new-candidate',
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./report.mjs', import.meta.url)),
        baseline,
        candidate,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Candidate prompt SHA-256: new-candidate/);
    assert.match(result.stdout, /Baseline prompt SHA-256: frozen-baseline/);
  }));

test('report refuses different actual candidate prompts', async () =>
  reportFixture((write) => {
    const first = write(
      'first',
      'candidate',
      'frozen-baseline',
      'candidate-one',
    );
    const second = write(
      'second',
      'candidate',
      'frozen-baseline',
      'candidate-two',
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./report.mjs', import.meta.url)), first, second],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different actual candidate prompts/);
  }));

test('report rejects a changed frozen baseline even when its candidate is valid', async () =>
  reportFixture((write) => {
    const baseline = write(
      'baseline',
      'baseline',
      'baseline-one',
      'unused-candidate',
    );
    const candidate = write(
      'candidate',
      'candidate',
      'baseline-two',
      'new-candidate',
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./report.mjs', import.meta.url)),
        baseline,
        candidate,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baselineSha256/);
  }));
