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
/** A phone app registered for APNs alerts through the `/push` command. */
export interface MobilePushDevice {
  /** APNs device token, lowercase hex. */
  token: string;
  environment: 'sandbox' | 'production';
  /** Notification kinds the app handles; nothing else is sent to it. */
  kinds: string[];
  /**
   * The app the phone belongs to, as it names itself in a chat's `client`.
   * Only chats from that app ring it. Absent: Hy (`mobile`).
   */
  client?: string;
}
