/**
 * Authenticated admin controls for plugin-owned local decision processes.
 * The HTTP server authenticates first; mutations additionally require loopback.
 * This handler does not install plugins or expose arbitrary executable paths.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '../channels/webhook-http.js';
import {
  getLocalClassifier,
  listLocalClassifiers,
} from '../routing/local-classifiers.js';
export async function handleLocalClassifierAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  loopback: boolean,
) {
  if (req.method === 'GET') {
    sendWebhookJson(res, 200, { classifiers: listLocalClassifiers() });
    return;
  }
  if (req.method !== 'POST') {
    sendWebhookJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!loopback) {
    sendWebhookJson(res, 403, {
      error: 'Manage local models from localhost on the gateway Mac.',
    });
    return;
  }
  try {
    const body = (await readWebhookJsonBody(req, {
      maxBytes: 1024,
      tooLargeMessage: 'Request too large.',
      invalidJsonMessage: 'Invalid JSON.',
      requireObject: true,
    })) as Record<string, unknown>;
    const classifier =
      typeof body.model === 'string'
        ? getLocalClassifier(body.model)
        : undefined;
    const action = body.action;
    if (
      !classifier ||
      (action !== 'setup' && action !== 'start' && action !== 'stop')
    ) {
      sendWebhookJson(res, 400, {
        error: 'Choose a registered local model and setup, start or stop.',
      });
      return;
    }
    classifier.command(action);
    sendWebhookJson(res, 202, { accepted: true });
  } catch (error) {
    sendWebhookJson(
      res,
      error instanceof WebhookHttpError ? error.statusCode : 409,
      { error: 'Local model operation could not be started.' },
    );
  }
}
