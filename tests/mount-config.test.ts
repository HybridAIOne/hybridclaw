import { describe, expect, test } from 'vitest';

import {
  parseBindSpec,
  resolveConfiguredAdditionalMounts,
} from '../src/security/mount-config.ts';

describe('mount config parsing', () => {
  test('parses OpenClaw-style bind specs', () => {
    expect(parseBindSpec('/host/data:/docs:ro')).toEqual({
      mount: {
        hostPath: '/host/data',
        containerPath: 'docs',
        readonly: true,
      },
    });

    expect(parseBindSpec('/host/cache:/cache:rw')).toEqual({
      mount: {
        hostPath: '/host/cache',
        containerPath: 'cache',
        readonly: false,
      },
    });
  });

  test('merges binds with legacy additionalMounts JSON', () => {
    const resolved = resolveConfiguredAdditionalMounts({
      binds: ['/host/data:/docs:ro'],
      additionalMounts:
        '[{"hostPath":"/legacy/path","containerPath":"legacy","readonly":false}]',
    });

    expect(resolved.warnings).toEqual([]);
    expect(resolved.mounts).toEqual([
      {
        hostPath: '/host/data',
        containerPath: 'docs',
        readonly: true,
      },
      {
        hostPath: '/legacy/path',
        containerPath: 'legacy',
        readonly: false,
      },
    ]);
  });
});
