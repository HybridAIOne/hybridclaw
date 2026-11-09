import { createHash } from 'node:crypto';

function stableHash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function sanitizeMcpToolSegment(value) {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
}

export function buildMcpServerNamespaces(serverNames) {
  const names = [...serverNames].sort((left, right) =>
    left.localeCompare(right),
  );
  const counts = new Map();

  for (const name of names) {
    const sanitized = sanitizeMcpToolSegment(name);
    counts.set(sanitized, (counts.get(sanitized) || 0) + 1);
  }

  const namespaces = new Map();
  const used = new Set();

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
