import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

// agent-browser stand-in: a checkout page whose snapshot shows what was
// typed, the way a real one shows a text field's value.
function createAgentBrowserStub(root: string, statePath: string): string {
  const scriptPath = path.join(root, 'agent-browser-payment-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];
const typed = fs.existsSync(${JSON.stringify(statePath)})
  ? JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf-8'))
  : {};
if (command === 'fill') {
  typed[commandArgs[0]] = commandArgs[1];
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(typed));
}
// The page groups the card number in fours and the expiry as "MM / YY".
const number = (typed['@e1'] || '').replace(/(\\d{4})(?=\\d)/g, '$1 ');
const expiry = (typed['@e2'] || '').replace('/', ' / ');
const field = (line, value) => (value ? line + ': ' + value : line);
const data =
  command === 'snapshot'
    ? {
        snapshot: [
          field('- textbox "Card number" [ref=e1]', number),
          field('- textbox "Expiry" [ref=e2]', expiry),
          field('- textbox "CVC" [ref=e3]', typed['@e3']),
          '- StaticText "Total 123,45 EUR"',
        ].join('\\n'),
        refs: {},
        url: 'https://shop.example/checkout?step=pay',
      }
    : {};
process.stdout.write(JSON.stringify({ success: true, data }));
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

const HELD_CARD = {
  saved: true,
  host: 'shop.example',
  secrets: {
    number: 'PAYCARD_A1_NUMBER',
    expiry: 'PAYCARD_A1_EXPIRY',
    expiry_month: 'PAYCARD_A1_EXPIRY_MONTH',
    expiry_year: 'PAYCARD_A1_EXPIRY_YEAR',
    expiry_year_short: 'PAYCARD_A1_EXPIRY_YEAR_SHORT',
    cvc: 'PAYCARD_A1_CVC',
  },
};
const CARD_VALUES: Record<string, string> = {
  PAYCARD_A1_NUMBER: '4242424242424242',
  PAYCARD_A1_EXPIRY: '04/28',
  PAYCARD_A1_CVC: '123',
};

async function loadTools(lookup: Record<string, unknown>) {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-payment-tool-'));
  const statePath = path.join(tempRoot, 'typed.json');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot, statePath));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      requests.push({ url, body });
      if (url.endsWith('/api/browser/payment-card')) {
        return new Response(JSON.stringify(lookup));
      }
      if (url.endsWith('/api/secret/inject')) {
        const value = CARD_VALUES[String(body.secretName)];
        return new Response(JSON.stringify({ ok: true, value }));
      }
      return new Response('{}', { status: 404 });
    }),
  );
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const tools = await import('../container/src/tools.js');
  tools.setGatewayContext('http://gateway.test', 'gateway-token', 'web');
  tools.setSessionContext('chat-1');
  return { tools, requests, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('without a card the tool asks the app for one and says to stop', async () => {
  const { tools, requests, stderr } = await loadTools({
    saved: false,
    host: 'shop.example',
  });

  const output = JSON.parse(
    await tools.executeTool(
      'browser_fill_payment',
      JSON.stringify({ number_ref: 'e1', expiry_ref: 'e2', cvc_ref: 'e3' }),
    ),
  ) as Record<string, unknown>;

  expect(requests.map((request) => request.url)).toEqual([
    'http://gateway.test/api/browser/payment-card',
  ]);
  expect(output).toMatchObject({ success: true, card_requested: true });
  expect(String(output.next)).toContain('Never ask for a card number');
  const frames = stderr.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('[browser-frame] '))
    .map((line) => JSON.parse(line.slice(16)));
  expect(frames).toEqual([
    {
      url: 'https://shop.example/checkout',
      title: '',
      paymentCard: { host: 'shop.example' },
    },
  ]);
});

test('a held card is typed into the page and never comes back to the model', async () => {
  const { tools, requests } = await loadTools(HELD_CARD);

  const output = await tools.executeTool(
    'browser_fill_payment',
    JSON.stringify({ number_ref: 'e1', expiry_ref: 'e2', cvc_ref: 'e3' }),
  );

  expect(JSON.parse(output)).toMatchObject({
    success: true,
    filled: ['number', 'expiry', 'cvc'],
  });
  expect(
    requests
      .filter((request) => request.url.endsWith('/api/secret/inject'))
      .map((request) => [request.body.secretName, request.body.host]),
  ).toEqual([
    ['PAYCARD_A1_NUMBER', 'shop.example'],
    ['PAYCARD_A1_EXPIRY', 'shop.example'],
    ['PAYCARD_A1_CVC', 'shop.example'],
  ]);

  // The page shows the typed card; the snapshot the model reads does not.
  const snapshot = await tools.executeTool('browser_snapshot', '{}');
  expect(snapshot).not.toMatch(/4242|04 \/ 28/);
  expect(snapshot).toContain('textbox \\"CVC\\" [ref=e3]: [typed secret]');
  // A short value is hidden only as a field's value, not in the total.
  expect(snapshot).toContain('Total 123,45 EUR');

  const picture = await tools.executeTool('browser_screenshot', '{}');
  expect(picture).toContain('pictures of it are off');
});
