/**
 * Proactive delivery over a plugin channel: refuses without the plugin or a
 * linked account and reports transport failures to proactive dispatch.
 * Target validation and quiet-hour queues belong to proactive-dispatch; this
 * sender neither reclassifies targets nor falls back to a local inbox.
 */
import { logger } from '../../logger.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import {
  getPluginChannelName,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import {
  describeMissingChannelTransport,
  getChannelTransport,
} from '../channel-transport.js';
import { sendPluginChannelText } from './runtime.js';

export async function sendPluginChannelProactive(
  kind: PluginChannelKind,
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const name = getPluginChannelName(kind);
  const registration = getChannelTransport(kind);
  if (!registration) {
    logger.warn(
      { source, channelId },
      `Proactive ${name} message suppressed: ${describeMissingChannelTransport(kind)}`,
    );
    return { status: 'failed', reason: 'transport plugin is not installed' };
  }
  if (!(await registration.getAuthStatus()).linked) {
    return { status: 'failed', reason: `${name} not linked` };
  }
  if (artifacts?.length) {
    logger.warn(
      { source, channelId, artifactCount: artifacts.length },
      `Proactive ${name} delivery currently sends text only`,
    );
  }
  await sendPluginChannelText(kind, channelId, text);
  return { status: 'delivered' };
}
