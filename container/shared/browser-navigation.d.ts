export function isPrivateBrowserIp(ip: string): boolean;
export function isPrivateBrowserHost(hostname: unknown): Promise<boolean>;
export function browserPrivateNetworkAllowed(
  env?: Record<string, string | undefined>,
): boolean;
export function assertBrowserNavigationUrl(
  raw: unknown,
  options?: {
    allowPrivateNetwork?: boolean;
    env?: Record<string, string | undefined>;
  },
): Promise<URL>;
