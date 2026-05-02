export const BROWSER_PROFILE_CHROMIUM_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  // Use Chromium's basic password store for this dedicated automation profile
  // so the persisted session stays readable to the automation runtime. This
  // intentionally avoids the OS keychain and should not be treated as a safe
  // default for general-purpose browsing profiles.
  '--password-store=basic',
  '--use-mock-keychain',
];
