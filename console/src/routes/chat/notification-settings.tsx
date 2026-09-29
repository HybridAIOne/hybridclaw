/**
 * Explicit notification consent and operator preferences for the chat sidebar.
 * Browser permission is requested only by its button, never by rendering it.
 */
import { Button } from '../../components/button';
import css from './notification-settings.module.css';
import type { useChatNotifications } from './use-chat-notifications';

export function NotificationSettings({
  notifications,
}: {
  notifications: ReturnType<typeof useChatNotifications>;
}) {
  return (
    <details className={css.settings}>
      <summary>Notifications</summary>
      <Button
        type="button"
        disabled={
          !notifications.supported || !notifications.state || notifications.busy
        }
        onClick={() => void notifications.toggle()}
      >
        {notifications.browserEnabled
          ? 'Disable notifications'
          : 'Enable notifications'}
      </Button>
      <p>
        {!notifications.supported
          ? 'Use HTTPS or localhost for browser notifications.'
          : notifications.pushEnabled
            ? 'Alerts work with the chat tab closed.'
            : notifications.browserEnabled
              ? 'Open-tab alerts enabled. Closed-tab push is unavailable in this browser or could not connect.'
              : 'Unread badges are always available.'}
      </p>
      {notifications.state && (
        <fieldset>
          <legend>Notify me about</legend>
          {(['turn', 'reminder', 'approval'] as const).map((kind) => (
            <label key={kind} className={css.preference}>
              <input
                type="checkbox"
                checked={notifications.state?.preferences[kind]}
                onChange={(event) => {
                  if (notifications.state)
                    void notifications.savePreferences({
                      ...notifications.state.preferences,
                      [kind]: event.target.checked,
                    });
                }}
              />
              {
                {
                  turn: 'Completed requests',
                  reminder: 'Reminders and scheduled output',
                  approval: 'Approval requests',
                }[kind]
              }
            </label>
          ))}
        </fieldset>
      )}
      {notifications.error && <p role="status">{notifications.error}</p>}
    </details>
  );
}
