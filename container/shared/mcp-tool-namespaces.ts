import { createHash } from 'node:crypto';

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function sanitizeMcpToolSegment(value: string): string {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
}

export function buildMcpServerNamespaces(
  serverNames: Iterable<string>,
): Map<string, string> {
  const names = [...serverNames].sort((left, right) =>
    left.localeCompare(right),
  );
  const counts = new Map<string, number>();

  for (const name of names) {
    const sanitized = sanitizeMcpToolSegment(name);
    counts.set(sanitized, (counts.get(sanitized) || 0) + 1);
  }

  const namespaces = new Map<string, string>();
  const used = new Set<string>();

  for (const name of names) {
    const sanitized = sanitizeMcpToolSegment(name);
    const trimmed = name.trim();
    const needsHash = sanitized !== trimmed || (counts.get(sanitized) || 0) > 1;
    const base = needsHash ? `${sanitized}_${stableHash(name)}` : sanitized;

    let candidate = base;
    let suffix = 1;
    while (used.has(candidate)) {
      candidate = `${base}_${stableHash(`${name}:${suffix}`)}`;
      suffix += 1;
    }

    used.add(candidate);
    namespaces.set(name, candidate);
  }

  return namespaces;
}
