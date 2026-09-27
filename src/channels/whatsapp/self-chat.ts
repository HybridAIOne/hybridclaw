/**
 * Shared self-chat notification advisory for setup, help, and diagnostics.
 * Unlike the transport, this module only explains delivery limitations; it
 * neither selects recipients nor changes WhatsApp access policies.
 */
export const WHATSAPP_SELF_CHAT_ADVISORY =
  'WhatsApp self-chat does not send push notifications; heartbeats, scheduled tasks, and delegation results delivered there can go unnoticed. For proactive notifications, pair a dedicated second number and use --allow-from <your-personal-number> to chat with it from your personal account.';
