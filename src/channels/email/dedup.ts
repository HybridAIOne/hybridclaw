export interface EmailDedupSet {
  add: (key: string) => boolean;
  has: (key: string) => boolean;
  clear: () => void;
  size: () => number;
}

class DefaultEmailDedupSet implements EmailDedupSet {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize: number) {}

  add(key: string): boolean {
    const normalized = String(key || '').trim();
    if (!normalized) return false;
    if (this.seen.has(normalized)) return false;

    this.seen.add(normalized);
    this.order.push(normalized);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(String(key || '').trim());
  }

  clear(): void {
    this.seen.clear();
    this.order.length = 0;
  }

  size(): number {
    return this.seen.size;
  }
}

export function createEmailDedupSet(maxSize = 10_000): EmailDedupSet {
  return new DefaultEmailDedupSet(Math.max(1, Math.floor(maxSize)));
}
