import { expect, test } from 'vitest';
import { createWhatsAppMessageStore } from '../src/channels/whatsapp/message-store.js';
import { useTempDir } from './test-utils.ts';

const createTempAuthDir = useTempDir('hybridclaw-wa-store-');

test('replays an exact stored WhatsApp message after reload', async () => {
  const authDir = await createTempAuthDir();
  const store = createWhatsAppMessageStore(authDir);

  await store.rememberSentMessage({
    key: {
      id: 'msg-1',
      remoteJid: '491701234567@s.whatsapp.net',
      participant: '491701234567@s.whatsapp.net',
      fromMe: true,
    },
    message: {
      conversation: 'hello from hybridclaw',
    },
  });

  const reloadedStore = createWhatsAppMessageStore(authDir);
  const replay = await reloadedStore.getMessage({
    id: 'msg-1',
    remoteJid: '491701234567@s.whatsapp.net',
    participant: '491701234567@s.whatsapp.net',
  });

  expect(replay?.conversation).toBe('hello from hybridclaw');
});

test('falls back to a unique message id when retry lookup lacks the original jid', async () => {
  const authDir = await createTempAuthDir();
  const store = createWhatsAppMessageStore(authDir);

  await store.rememberSentMessage({
    key: {
      id: 'msg-2',
      remoteJid: '491701234567@s.whatsapp.net',
      fromMe: true,
    },
    message: {
      conversation: 'retry me',
    },
  });

  const replay = await store.getMessage({
    id: 'msg-2',
    remoteJid: '1061007917075@lid',
  });

  expect(replay?.conversation).toBe('retry me');
});

test('clear removes persisted replay entries', async () => {
  const authDir = await createTempAuthDir();
  const store = createWhatsAppMessageStore(authDir);

  await store.rememberSentMessage({
    key: {
      id: 'msg-3',
      remoteJid: '491701234567@s.whatsapp.net',
      fromMe: true,
    },
    message: {
      conversation: 'goodbye',
    },
  });
  await store.clear();

  const reloadedStore = createWhatsAppMessageStore(authDir);
  const replay = await reloadedStore.getMessage({
    id: 'msg-3',
    remoteJid: '491701234567@s.whatsapp.net',
  });

  expect(replay).toBeUndefined();
});

test('does not fall back by id when multiple stored messages share the same id', async () => {
  const authDir = await createTempAuthDir();
  const store = createWhatsAppMessageStore(authDir);

  await store.rememberSentMessage({
    key: {
      id: 'msg-duplicate',
      remoteJid: '491701234567@s.whatsapp.net',
      fromMe: true,
    },
    message: {
      conversation: 'first',
    },
  });

  await store.rememberSentMessage({
    key: {
      id: 'msg-duplicate',
      remoteJid: '491709876543@s.whatsapp.net',
      fromMe: true,
    },
    message: {
      conversation: 'second',
    },
  });

  const replay = await store.getMessage({
    id: 'msg-duplicate',
    remoteJid: '1061007917075@lid',
  });

  expect(replay).toBeUndefined();
});
