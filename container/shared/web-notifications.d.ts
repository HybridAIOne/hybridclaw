export type WebNotificationKind = 'turn' | 'reminder' | 'approval';
export type WebNotificationPreferences = Record<WebNotificationKind, boolean>;
export interface WebNotification {
  id: string;
  sessionId: string;
  agentId: string | null;
  kind: WebNotificationKind;
  title: string;
  createdAt: number;
}
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface WebNotificationState {
  operatorId: string;
  preferences: WebNotificationPreferences;
  notifications: WebNotification[];
}
/** A phone app registered for mobile alerts through the `/push` command. */
export interface MobilePushDevice {
  /** APNs hex or case-sensitive Firebase registration token. */
  token: string;
  environment: 'sandbox' | 'production';
  /** Omitted for an Apple phone. */
  platform?: 'ios' | 'android';
  /** Notification kinds the app handles; nothing else is sent to it. */
  kinds: string[];
  /**
   * The HybridAI app the phone registered for, as its chats name it in
   * `appId`. Only that app's chats ring it, and HybridAI signs its alerts for
   * that app. Absent: Hy (`hy`).
   */
  app?: string;
}
