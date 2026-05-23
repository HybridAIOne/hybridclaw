import { describe, expect, test } from 'vitest';

import {
  parseBindSpecs,
  resolveConfiguredAdditionalMounts,
} from '../src/security/mount-config.ts';

describe('mount config parsing', () => {
  test('parses OpenClaw-style bind specs', () => {
    expect(parseBindSpecs(['/host/data:/docs:ro'])).toEqual({
      mounts: [
        {
          hostPath: '/host/data',
          containerPath: 'docs',
          readonly: true,
        },
      ],
      warnings: [],
    });

    expect(parseBindSpecs(['/host/cache:/cache:rw'])).toEqual({
      mounts: [
        {
          hostPath: '/host/cache',
          containerPath: 'cache',
          readonly: false,
        },
      ],
      warnings: [],
    });
  });

  test('surfaces warnings for invalid bind specs', () => {
    expect(parseBindSpecs(['missing-delimiter'])).toEqual({
      mounts: [],
      warnings: [
        'bind spec must use host:container[:ro|rw] format (for example "/host/data:/data:ro")',
      ],
    });

    expect(parseBindSpecs(['/host/data:/workspace:ro'])).toEqual({
      mounts: [],
      warnings: [
        'bind spec "/host/data:/workspace:ro" targets a reserved container path',
      ],
    });
  });

  test('deduplicates repeated bind specs', () => {
    expect(
      parseBindSpecs([
        '/host/data:/docs:ro',
        '/host/data:/docs:ro',
        '/host/data:/docs',
      ]),
    ).toEqual({
      mounts: [
        {
          hostPath: '/host/data',
          containerPath: 'docs',
          readonly: true,
        },
      ],
      warnings: [],
    });
  });

  test('ignores legacy additionalMounts JSON', () => {
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
    ]);
  });
});
