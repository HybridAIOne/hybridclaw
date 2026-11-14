import { describe, expect, test } from 'vitest';
import {
  isWhatsAppJid,
  normalizePhoneNumber,
  phoneToJid,
} from '../src/channels/whatsapp/phone.js';

describe('whatsapp phone helpers', () => {
  test('normalizes E.164 numbers from loose input', () => {
    expect(normalizePhoneNumber(' +49 151 2345 6789 ')).toBe('+4915123456789');
    expect(normalizePhoneNumber('whatsapp:(555) 123-4567')).toBe('+5551234567');
    expect(normalizePhoneNumber('abc')).toBeNull();
  });

  test('converts phones to user jids', () => {
    expect(phoneToJid('+4915123456789')).toBe('4915123456789@s.whatsapp.net');
  });

  test('detects supported WhatsApp jid shapes', () => {
    expect(isWhatsAppJid('4915123456789@s.whatsapp.net')).toBe(true);
    expect(isWhatsAppJid('120363401234567890@g.us')).toBe(true);
    expect(isWhatsAppJid('123456789012345678')).toBe(false);
  });
});
