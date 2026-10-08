/**
 * Fake of the released hybridclaw-whatsapp 0.1.x plugin: the same create-only
 * registration and the same host calls (auth lock and directory, pairing QR,
 * phone helpers, session keys), with WhatsApp Web replaced by an inbound
 * webhook that injects a self-chat message and returns the replies.
 *
 * POST /api/plugin-webhooks/whatsapp/inbound {"text": "..."} -> {"replies": [...]}
 * GET  /api/plugin-webhooks/whatsapp/outbox -> {"sent": [...], "host": {...}}
 */
import fs from 'node:fs';
import path from 'node:path';

const state = {
  handler: null,
  host: null,
  releaseLock: null,
  sent: [],
};

function readCreds(host) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(host.auth.authDir, 'creds.json'), 'utf-8'),
    );
  } catch {
    return {};
  }
}

function describeHost(host) {
  return {
    authDir: host.auth.authDir,
    authHelpers: [
      typeof host.auth.acquireLock,
      typeof host.auth.ensureAuthDir,
    ],
    pairingHelpers: Object.keys(host.pairing).sort(),
    phoneHelpers: Object.keys(host.phone).sort(),
    canonicalSelf: host.phone.canonicalizeUserJid('491701234567:7@s.whatsapp.net'),
    config: host.getConfig(),
  };
}

function createTransport(host) {
  return {
    async init(handler) {
      state.host = host;
      state.handler = handler;
      await host.auth.ensureAuthDir();
      state.releaseLock = await host.auth.acquireLock(undefined, {
        purpose: 'runtime',
      });
      const me = readCreds(host).me?.id;
      if (!me) host.pairing.setQrText('FAKE-WHATSAPP-QR');
      else host.pairing.clear();
    },
    async shutdown() {
      state.releaseLock?.();
      state.releaseLock = null;
      state.handler = null;
    },
    async sendText(chatId, text) {
      state.sent.push({ kind: 'text', chatId, text });
      return { messageIds: [`fake-${state.sent.length}`] };
    },
    async sendMedia(params) {
      state.sent.push({ kind: 'media', chatId: params.jid, filePath: params.filePath });
      return { messageIds: [`fake-${state.sent.length}`] };
    },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export default {
  id: 'whatsapp',
  name: 'WhatsApp (legacy contract fixture)',
  version: '0.1.1',
  kind: 'channel',
  register(api) {
    api.registerChannelTransport({ kind: 'whatsapp', create: createTransport });

    api.registerInboundWebhook({
      name: 'inbound',
      method: 'POST',
      async handler({ req, res }) {
        if (!state.handler || !state.host) {
          sendJson(res, 409, { error: 'transport not initialized' });
          return;
        }
        const body = await readJson(req);
        const jid = state.host.phone.canonicalizeUserJid(
          readCreds(state.host).me?.id || '',
        );
        if (!jid) {
          sendJson(res, 409, { error: 'not linked' });
          return;
        }
        const replies = [];
        const peer = state.host.phone.normalizeUserIdentity(jid);
        await state.handler(
          state.host.buildSessionKey(
            state.host.defaultAgentId,
            'whatsapp',
            'dm',
            peer,
          ),
          null,
          jid,
          jid,
          'Fixture User',
          state.host.text.normalizeNativeAgentAddressingText(
            String(body.text || ''),
          ),
          [],
          async (content) => {
            replies.push(content);
          },
          {
            abortSignal: new AbortController().signal,
            batchedMessages: [],
            rawMessage: body,
            chatJid: jid,
            senderJid: jid,
            isGroup: false,
          },
        );
        sendJson(res, 200, { replies });
      },
    });

    api.registerInboundWebhook({
      name: 'outbox',
      method: 'GET',
      handler({ res }) {
        sendJson(res, 200, {
          sent: state.sent,
          host: state.host ? describeHost(state.host) : null,
        });
      },
    });
  },
};
