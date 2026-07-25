const DOCUMENTATION_HOST_SUFFIXES = [
  'example',
  'example.com',
  'example.net',
  'example.org',
];

function isDocumentationHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return DOCUMENTATION_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

export function parseBlueBubblesServerUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid BlueBubbles server URL: ${rawUrl}`);
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('BlueBubbles server URL must use http or https.');
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (isDocumentationHost(hostname)) {
    throw new Error(
      `BlueBubbles server URL uses a documentation-only host: ${hostname}`,
    );
  }

  return parsed;
}
