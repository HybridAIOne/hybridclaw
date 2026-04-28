import type { Config } from '@ngrok/ngrok';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import type {
  TunnelProvider,
  TunnelStartResult,
  TunnelStatus,
} from './tunnel-provider.js';

export const NGROK_AUTHTOKEN_SECRET = 'NGROK_AUTHTOKEN';
export const DEFAULT_NGROK_TUNNEL_ADDR = 9090;

interface NgrokListener {
  url(): string | null;
  close(): Promise<void>;
}

interface NgrokClient {
  forward(config: Config | string | number): Promise<NgrokListener>;
}

export interface NgrokTunnelProviderOptions {
  addr?: Config['addr'];
  domain?: string;
  forwardsTo?: string;
  metadata?: string;
  readSecret?: (secretName: string) => string | null;
  schemes?: string[];
  tokenSecretName?: string;
  loadNgrok?: () => Promise<NgrokClient>;
}

async function loadDefaultNgrok(): Promise<NgrokClient> {
  return import('@ngrok/ngrok');
}

function normalizePublicUrl(value: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('ngrok listener did not report a public URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ngrok listener reported an invalid public URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `ngrok listener reported a non-HTTP public URL: ${parsed.protocol}`,
    );
  }

  return parsed.toString().replace(/\/$/, '');
}

function redactSecret(message: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return message;
  return message.split(trimmed).join('<redacted>');
}

export class NgrokTunnelProvider implements TunnelProvider {
  private readonly addr: Config['addr'];
  private readonly domain?: string;
  private readonly forwardsTo?: string;
  private readonly metadata?: string;
  private readonly readSecret: (secretName: string) => string | null;
  private readonly schemes?: string[];
  private readonly tokenSecretName: string;
  private readonly loadNgrok: () => Promise<NgrokClient>;
  private listener: NgrokListener | null = null;
  private publicUrl: string | null = null;

  constructor(options: NgrokTunnelProviderOptions = {}) {
    this.addr = options.addr ?? DEFAULT_NGROK_TUNNEL_ADDR;
    this.domain = options.domain;
    this.forwardsTo = options.forwardsTo;
    this.metadata = options.metadata;
    this.readSecret = options.readSecret ?? readStoredRuntimeSecret;
    this.schemes = options.schemes;
    this.tokenSecretName =
      options.tokenSecretName?.trim() || NGROK_AUTHTOKEN_SECRET;
    this.loadNgrok = options.loadNgrok ?? loadDefaultNgrok;
  }

  async start(): Promise<TunnelStartResult> {
    if (this.listener && this.publicUrl) {
      return { public_url: this.publicUrl };
    }

    const token = this.readSecret(this.tokenSecretName)?.trim() || '';
    if (!token) {
      throw new Error(
        `ngrok auth token is not configured in encrypted runtime secrets. Store it with \`hybridclaw secret set ${this.tokenSecretName} <token>\`.`,
      );
    }

    let listener: NgrokListener | null = null;
    try {
      const ngrok = await this.loadNgrok();
      const config: Config = {
        addr: this.addr,
        authtoken: token,
        proto: 'http',
      };
      if (this.domain) config.domain = this.domain;
      if (this.forwardsTo) config.forwards_to = this.forwardsTo;
      if (this.metadata) config.metadata = this.metadata;
      if (this.schemes) config.schemes = this.schemes;

      listener = await ngrok.forward(config);
      const publicUrl = normalizePublicUrl(listener.url());
      this.listener = listener;
      this.publicUrl = publicUrl;
      return { public_url: publicUrl };
    } catch (error) {
      if (listener) {
        try {
          await listener.close();
        } catch {
          // Preserve the original start failure.
        }
      }
      this.listener = null;
      this.publicUrl = null;
      throw new Error(
        `Failed to start ngrok tunnel: ${redactSecret(error instanceof Error ? error.message : String(error), token)}`,
      );
    }
  }

  async stop(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    this.publicUrl = null;
    if (listener) {
      await listener.close();
    }
  }

  async status(): Promise<TunnelStatus> {
    return {
      running: Boolean(this.listener && this.publicUrl),
      public_url: this.publicUrl,
    };
  }
}

export function createNgrokTunnelProvider(
  options: NgrokTunnelProviderOptions = {},
): TunnelProvider {
  return new NgrokTunnelProvider(options);
}
