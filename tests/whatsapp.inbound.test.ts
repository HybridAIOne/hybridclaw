import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  cleanupWhatsAppInboundMedia,
  evaluateWhatsAppAccessPolicy,
  processInboundWhatsAppMessage,
} from '../src/channels/whatsapp/inbound.js';

const BASE_WHATSAPP_CONFIG = {
  dmPolicy: 'pairing' as const,
  groupPolicy: 'disabled' as const,
  allowFrom: [],
  groupAllowFrom: [],
  textChunkLimit: 4000,
  debounceMs: 2500,
  sendReadReceipts: true,
  ackReaction: '',
  mediaMaxMb: 20,
};

const NOOP_WA_LOGGER = {
  level: 'info',
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('whatsapp inbound policy filtering', () => {
  test('allows self-chat even when pairing mode is restrictive', () => {
    const result = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      chatJid: '4915123456789@s.whatsapp.net',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJid: '4915123456789:1@s.whatsapp.net',
      fromMe: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
    expect(result.isGroup).toBe(false);
  });

  test('blocks unauthorized direct messages in allowlist mode', () => {
    const result = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: ['+4915123456789'],
      groupAllowFrom: [],
      chatJid: '4915123456789@s.whatsapp.net',
      senderJid: '498912345678@s.whatsapp.net',
      selfJid: '4915123456789@s.whatsapp.net',
      fromMe: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.isGroup).toBe(false);
  });

  test('keeps groups private by default and allows explicit group allowlists', () => {
    const blocked = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: ['+4915123456789'],
      groupAllowFrom: [],
      chatJid: '120363401234567890@g.us',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJid: '4915000000000@s.whatsapp.net',
      fromMe: false,
    });
    const allowed = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'open',
      groupPolicy: 'allowlist',
      allowFrom: ['+4915000000000'],
      groupAllowFrom: ['+4915123456789'],
      chatJid: '120363401234567890@g.us',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJid: '4915000000000@s.whatsapp.net',
      fromMe: false,
    });

    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
    expect(allowed.isGroup).toBe(true);
  });

  test('ignores inbound events without text or media payload', async () => {
    const result = await processInboundWhatsAppMessage({
      message: {
        key: {
          id: 'msg-empty-1',
          fromMe: false,
          remoteJid: '4915123456789@s.whatsapp.net',
        },
        message: {},
      },
      sock: {
        updateMediaMessage: async () => undefined,
        logger: NOOP_WA_LOGGER,
      },
      config: BASE_WHATSAPP_CONFIG,
      selfJid: '4915123456789:1@s.whatsapp.net',
    });

    expect(result).toBeNull();
  });

  test('cleanupWhatsAppInboundMedia removes managed WhatsApp temp dirs only', async () => {
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-wa-'));
    const managedFile = path.join(managedDir, 'voice.ogg');
    fs.writeFileSync(managedFile, 'audio');

    const unmanagedDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-other-'),
    );
    const unmanagedFile = path.join(unmanagedDir, 'note.txt');
    fs.writeFileSync(unmanagedFile, 'keep');

    await cleanupWhatsAppInboundMedia([
      {
        path: managedFile,
        url: `file://${managedFile}`,
        originalUrl: `file://${managedFile}`,
        mimeType: 'audio/ogg',
        sizeBytes: 5,
        filename: 'voice.ogg',
      },
      {
        path: unmanagedFile,
        url: `file://${unmanagedFile}`,
        originalUrl: `file://${unmanagedFile}`,
        mimeType: 'text/plain',
        sizeBytes: 4,
        filename: 'note.txt',
      },
    ]);

    expect(fs.existsSync(managedDir)).toBe(false);
    expect(fs.existsSync(unmanagedFile)).toBe(true);

    fs.rmSync(unmanagedDir, { recursive: true, force: true });
  });
});
