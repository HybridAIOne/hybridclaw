import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { containerHostAliasArgs } from '../src/infra/container-host-alias.js';
import { dockerBridgeGateway } from './helpers/docker-test-setup.js';

const exec = promisify(execFile);
const IMAGE = 'node:22-slim';

async function listen(host: string): Promise<http.Server> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server;
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

async function fetchFromContainer(
  network: string,
  hostArgs: string[],
  port: number,
): Promise<string> {
  const probe = `fetch('http://host.docker.internal:${port}/',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('status:'+r.status),e=>console.log('error:'+(e.cause?.code||e.name)))`;
  const { stdout } = await exec(
    'docker',
    [
      'run',
      '--rm',
      `--network=${network}`,
      ...hostArgs,
      IMAGE,
      'node',
      '-e',
      probe,
    ],
    { timeout: 60_000 },
  );
  return stdout.trim();
}

describe
  .skipIf(
    process.env.HYBRIDCLAW_TEST_DOCKER !== '1' || process.platform !== 'linux',
  )
  .sequential('host.docker.internal from a Linux agent container', () => {
    let bridgeServer: http.Server;
    let loopbackServer: http.Server;

    beforeAll(async () => {
      await exec('docker', ['pull', '-q', IMAGE], { timeout: 120_000 });
      bridgeServer = await listen(dockerBridgeGateway());
      loopbackServer = await listen('127.0.0.1');
    }, 180_000);
    afterAll(async () => {
      await Promise.all(
        [bridgeServer, loopbackServer].map(
          (server) =>
            new Promise((resolve) =>
              server ? server.close(resolve) : resolve(undefined),
            ),
        ),
      );
    });

    test('resolves the rewritten host name only with the mapping', async () => {
      const port = portOf(bridgeServer);
      await expect(
        fetchFromContainer(
          'bridge',
          containerHostAliasArgs('linux', 'bridge'),
          port,
        ),
      ).resolves.toBe('status:200');
      await expect(fetchFromContainer('bridge', [], port)).resolves.toBe(
        'error:ENOTFOUND',
      );
    }, 120_000);

    test('keeps host services bound to loopback out of reach', async () => {
      await expect(
        fetchFromContainer(
          'bridge',
          containerHostAliasArgs('linux', 'bridge'),
          portOf(loopbackServer),
        ),
      ).resolves.toMatch(/^error:/);
    }, 120_000);

    test('leaves a network-disabled container without a route', async () => {
      expect(containerHostAliasArgs('linux', 'none')).toEqual([]);
      await expect(
        fetchFromContainer('none', [], portOf(bridgeServer)),
      ).resolves.toMatch(/^error:/);
    }, 120_000);
  });
