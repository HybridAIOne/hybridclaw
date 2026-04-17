export const RESOURCE_HYGIENE_SYSTEM_EVENT = 'resource_hygiene_maintenance';

export const DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB = Object.freeze({
  id: 'resource-hygiene',
  name: 'Resource Hygiene',
  description:
    'Runs conservative doctor-based resource hygiene and auto-applies safe cleanup.',
  schedule: {
    kind: 'every',
    at: null,
    everyMs: 43_200_000,
    expr: null,
    tz: 'UTC',
  },
  action: {
    kind: 'system_event',
    message: RESOURCE_HYGIENE_SYSTEM_EVENT,
  },
  // delivery is required by RuntimeSchedulerJob but ignored for system_event
  // actions — dispatchConfigJob short-circuits before reaching delivery routing.
  delivery: {
    kind: 'last-channel',
    channel: '',
    to: '',
    webhookUrl: '',
  },
  enabled: true,
} as const);
