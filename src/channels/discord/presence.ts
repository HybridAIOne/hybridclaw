import { ActivityType, type Client, type PresenceStatusData } from 'discord.js';

import { logger } from '../../logger.js';

export type PresenceHealthState =
  | 'healthy'
  | 'degraded'
  | 'exhausted'
  | 'maintenance';
export type DiscordPresenceActivityType =
  | 'playing'
  | 'watching'
  | 'listening'
  | 'competing'
  | 'custom';

export interface DiscordAutoPresenceConfig {
  enabled: boolean;
  intervalMs: number;
  healthyText: string;
  degradedText: string;
  exhaustedText: string;
  activityType: DiscordPresenceActivityType;
}

type PresenceConfigResolver = () => DiscordAutoPresenceConfig;
type PresenceStateResolver = () => PresenceHealthState;

function toDiscordActivityType(
  type: DiscordPresenceActivityType,
): ActivityType {
  switch (type) {
    case 'playing':
      return ActivityType.Playing;
    case 'listening':
      return ActivityType.Listening;
    case 'competing':
      return ActivityType.Competing;
    case 'custom':
      return ActivityType.Custom;
    case 'watching':
    default:
      return ActivityType.Watching;
  }
}

function presenceTextForState(
  config: DiscordAutoPresenceConfig,
  state: PresenceHealthState,
): string {
  if (state === 'degraded') return config.degradedText;
  if (state === 'exhausted') return config.exhaustedText;
  return config.healthyText;
}

function presenceStatusForState(
  state: PresenceHealthState,
): PresenceStatusData {
  if (state === 'maintenance') return 'invisible';
  if (state === 'exhausted') return 'dnd';
  if (state === 'degraded') return 'idle';
  return 'online';
}

export class DiscordAutoPresenceController {
  private readonly client: Client;
  private readonly getConfig: PresenceConfigResolver;
  private readonly resolveState: PresenceStateResolver;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private maintenance = false;
  private lastFingerprint = '';

  constructor(params: {
    client: Client;
    getConfig: PresenceConfigResolver;
    resolveState: PresenceStateResolver;
  }) {
    this.client = params.client;
    this.getConfig = params.getConfig;
    this.resolveState = params.resolveState;
  }

  start(): void {
    this.stop();
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      await this.evaluateNow();
      if (!this.running) return;
      const intervalMs = Math.max(
        5_000,
        Math.floor(this.getConfig().intervalMs),
      );
      this.timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    };
    this.timer = setTimeout(() => {
      void tick();
    }, 0);
  }

  stop(): void {
    this.running = false;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async setMaintenance(): Promise<void> {
    this.maintenance = true;
    await this.evaluateNow();
  }

  private async evaluateNow(): Promise<void> {
    const config = this.getConfig();
    if (!this.client.user) return;
    if (!config.enabled && !this.maintenance) return;

    const state = this.maintenance ? 'maintenance' : this.resolveState();
    const status = presenceStatusForState(state);
    const activityText =
      state === 'maintenance' ? '' : presenceTextForState(config, state);
    const activityType = toDiscordActivityType(config.activityType);
    const fingerprint = `${state}:${status}:${activityType}:${activityText}`;
    if (fingerprint === this.lastFingerprint) return;

    try {
      if (state === 'maintenance') {
        await this.client.user.setPresence({
          status,
          activities: [],
        });
      } else {
        await this.client.user.setPresence({
          status,
          activities: activityText
            ? [{ name: activityText, type: activityType }]
            : [],
        });
      }
      this.lastFingerprint = fingerprint;
    } catch (error) {
      logger.debug({ error, state }, 'Failed to update Discord presence');
    }
  }
}
