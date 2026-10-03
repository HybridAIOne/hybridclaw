/**
 * threema gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { hasThreemaGatewaySecret, initThreema } from './runtime.js';

export async function startThreemaIntegration(): Promise<boolean> {
  const threemaConfig = getConfigSnapshot().threema;
  const hasSecret = hasThreemaGatewaySecret();

  if (!threemaConfig.enabled) {
    logger.info('Threema integration disabled: threema.enabled=false');
    return false;
  }
  if (threemaConfig.dmPolicy === 'disabled') {
    logger.info('Threema integration disabled: transport is off');
    return false;
  }
  if (!threemaConfig.identity) {
    logger.info('Threema integration disabled: threema.identity is not set');
    return false;
  }
  if (!hasSecret) {
    logger.info(
      'Threema integration disabled: THREEMA_GATEWAY_SECRET is not configured',
    );
    return false;
  }

  try {
    await initThreema();
  } catch (error) {
    logger.warn({ error }, 'Threema integration failed to start');
    return false;
  }

  logger.info('Threema integration started inside gateway');
  return true;
}
