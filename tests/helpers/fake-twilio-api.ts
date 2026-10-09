/**
 * A local stand-in for Twilio's side of a call: the REST Calls API a gateway
 * uses to place an outbound call, and the signed incoming-call webhook Twilio
 * then sends to the URL that call named. Signatures follow Twilio's documented
 * X-Twilio-Signature scheme, computed here independently of the plugin.
 *
 * NOT a voice platform: no audio, no ConversationRelay; tests open those
 * sockets themselves from the TwiML the webhook returned.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return createHmac('sha1', authToken).update(payload).digest('base64');
}

export interface FakeTwilioCall {
  accountSid: string;
  authorized: boolean;
  params: Record<string, string>;
  webhook: Promise<{ status: number; body: string }>;
}

export interface FakeTwilioApi {
  url: string;
  calls: FakeTwilioCall[];
  /** Source of a `node --import` module sending api.twilio.com to this fake. */
  fetchRedirectModule: string;
  close(): Promise<void>;
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}

export async function startFakeTwilioApi(opts: {
  port: number;
  authToken: string;
  /** Maps the public webhook URL Twilio would call to a reachable one. */
  toReachableUrl: (publicUrl: string) => string;
}): Promise<FakeTwilioApi> {
  const calls: FakeTwilioCall[] = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const match =
      /^\/2010-04-01\/Accounts\/([^/]+)\/Calls\.json$/.exec(req.url || '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    const accountSid = decodeURIComponent(match[1]);
    const params = await readForm(req);
    const expectedAuth = `Basic ${Buffer.from(`${accountSid}:${opts.authToken}`).toString('base64')}`;
    const authorized = req.headers.authorization === expectedAuth;
    if (!authorized) {
      const webhook = Promise.resolve({ status: 0, body: '' });
      calls.push({ accountSid, authorized, params, webhook });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 20003, message: 'Authenticate' }));
      return;
    }
    sequence += 1;
    const callSid = `CAoutbound${String(sequence).padStart(24, '0')}`;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        sid: callSid,
        status: 'queued',
        to: params.To,
        from: params.From,
      }),
    );
    // Twilio dials, the callee answers, and Twilio fetches TwiML from Url.
    const webhookParams = {
      CallSid: callSid,
      AccountSid: accountSid,
      From: params.From,
      To: params.To,
      Direction: 'outbound-api',
      CallStatus: 'in-progress',
    };
    const webhook = fetch(opts.toReachableUrl(params.Url), {
      method: params.Method || 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(
          opts.authToken,
          params.Url,
          webhookParams,
        ),
      },
      body: new URLSearchParams(webhookParams),
    }).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }));
    calls.push({ accountSid, authorized, params, webhook });
  });
  await new Promise<void>((resolve) =>
    server.listen(opts.port, '127.0.0.1', resolve),
  );
  const url = `http://127.0.0.1:${opts.port}`;
  return {
    url,
    calls,
    fetchRedirectModule: [
      'const realFetch = globalThis.fetch;',
      'globalThis.fetch = (input, init) => {',
      "  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;",
      "  if (href.startsWith('https://api.twilio.com/')) {",
      `    return realFetch(${JSON.stringify(url)} + href.slice('https://api.twilio.com'.length), init);`,
      '  }',
      '  return realFetch(input, init);',
      '};',
      '',
    ].join('\n'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
