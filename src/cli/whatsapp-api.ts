import { makeLazyApi } from './common.js';

type WhatsAppAuthApi = typeof import('../channels/whatsapp/auth.js');
type WhatsAppConnectionApi =
  typeof import('../channels/whatsapp/connection.js');
type WhatsAppPhoneApi = typeof import('../channels/whatsapp/phone.js');

const whatsAppAuthApiState = makeLazyApi<WhatsAppAuthApi>(
  () => import('../channels/whatsapp/auth.js'),
  'WhatsApp auth API accessed before it was initialized. Call ensureWhatsAppAuthApi() first.',
);
const whatsAppConnectionApiState = makeLazyApi<WhatsAppConnectionApi>(
  () => import('../channels/whatsapp/connection.js'),
  'WhatsApp connection API accessed before it was initialized. Call ensureWhatsAppConnectionApi() first.',
);
const whatsAppPhoneApiState = makeLazyApi<WhatsAppPhoneApi>(
  () => import('../channels/whatsapp/phone.js'),
  'WhatsApp phone API accessed before it was initialized. Call ensureWhatsAppPhoneApi() first.',
);

export async function ensureWhatsAppAuthApi(): Promise<WhatsAppAuthApi> {
  return whatsAppAuthApiState.ensure();
}

export function getWhatsAppAuthApi(): WhatsAppAuthApi {
  return whatsAppAuthApiState.get();
}

export async function ensureWhatsAppConnectionApi(): Promise<WhatsAppConnectionApi> {
  return whatsAppConnectionApiState.ensure();
}

export function getWhatsAppConnectionApi(): WhatsAppConnectionApi {
  return whatsAppConnectionApiState.get();
}

export async function ensureWhatsAppPhoneApi(): Promise<WhatsAppPhoneApi> {
  return whatsAppPhoneApiState.ensure();
}

export function getWhatsAppPhoneApi(): WhatsAppPhoneApi {
  return whatsAppPhoneApiState.get();
}
