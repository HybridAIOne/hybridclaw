/**
 * Scheduled-job webhook delivery. Every POST goes to a public HTTPS endpoint
 * through the SSRF guard (no redirects) and carries the same HMAC signature
 * header as A2A webhooks, keyed by the stored `SCHEDULER_WEBHOOK_SECRET`; a
 * delivery without that secret fails rather than going out unsigned.
 *
 * NOT the A2A webhook outbox: there is no retry queue here; the scheduler's
 * own retry policy owns failed runs.
 */
import {
  signWebhookBody,
  WEBHOOK_SIGNATURE_HEADER,
} from '../a2a/webhook-outbound.js';
import { fetchPublicHttpsBuffer } from '../security/public-https-fetch.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import type { ArtifactMetadata } from '../types/execution.js';

export const SCHEDULER_WEBHOOK_SECRET_NAME = 'SCHEDULER_WEBHOOK_SECRET';

export async function deliverScheduledWebhook(
  webhookUrl: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<void> {
  const secret = readStoredRuntimeSecret(SCHEDULER_WEBHOOK_SECRET_NAME);
  if (!secret) {
    throw new Error(
      `Webhook delivery requires a signing secret: run \`hybridclaw secret set ${SCHEDULER_WEBHOOK_SECRET_NAME} <secret>\`.`,
    );
  }
  const body = JSON.stringify({
    text,
    source,
    artifactCount: artifacts?.length || 0,
    artifacts: (artifacts || []).map((artifact) => ({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    })),
  });
  try {
    await fetchPublicHttpsBuffer(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody({ body, secret }),
      },
      body,
    });
  } catch (error) {
    throw new Error(
      `Webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
