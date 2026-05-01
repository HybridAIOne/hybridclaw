import type { SecretHandle } from '../security/secret-handles.js';
import { resolveSecretInputUnsafe } from '../security/secret-refs.js';
import type { InvoiceCredentialInputs, InvoiceCredentials } from './types.js';

export function resolveInvoiceCredentials(
  providerId: string,
  inputs: InvoiceCredentialInputs,
  opts: {
    required?: string[];
    audit?: (handle: SecretHandle, reason: string) => void;
  } = {},
): InvoiceCredentials {
  const required = new Set(opts.required || []);
  const resolved: InvoiceCredentials = {};

  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined) continue;
    // This resolver returns the cleartext secret to the caller; keep the value
    // local and rely on the supplied audit hook for the secret handle trail.
    const secret = resolveSecretInputUnsafe(value, {
      path: `invoiceProviders.${providerId}.credentials.${key}`,
      required: required.has(key),
      reason: `resolve ${providerId} invoice credential ${key}`,
      audit:
        opts.audit ||
        (() => {
          // Callers that need external audit events can inject an audit recorder.
        }),
    });
    if (secret) resolved[key] = secret;
  }

  for (const key of required) {
    if (!resolved[key]) {
      throw new Error(
        `Missing required ${providerId} invoice credential ${key}.`,
      );
    }
  }

  return resolved;
}
