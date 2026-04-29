import { createHash } from 'node:crypto';

export function md5Hex(content: string): string {
  return createHash('md5').update(content).digest('hex');
}
