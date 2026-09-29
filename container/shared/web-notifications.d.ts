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
