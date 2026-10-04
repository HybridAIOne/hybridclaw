# Android phone alerts

The Hy Android app registers a Firebase token through an authenticated web chat session:

```text
/push register <firebase-token> production turn,reminder,approval hy android
/push unregister <firebase-token> android
```

The token is case-sensitive. Android registrations are kept alongside Apple phones and forwarded with `platform: "android"` to the platform push relay. Android uses the production environment and the `hy` app. The reply includes `platform: "android"` so the phone can confirm this runtime supports it.

The platform holds Firebase credentials and enforces account ownership. Configure Firebase on that relay and in the Android build; there is no Firebase service account key in a runtime sandbox. Reminders, finished replies and approvals use the existing per-session ownership, notification preferences and app routing.
