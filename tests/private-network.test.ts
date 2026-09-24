import { expect, test } from 'vitest';

import { isPrivateNetworkAddress } from '../container/shared/private-network.js';

test.each([
  '0.0.0.0',
  '10.1.2.3',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.0.192',
  '192.168.1.1',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fc00::1',
  'fd00:ec2::254',
  'fe80::1',
  'febf::1',
  'fe80::1%lo0',
  // IPv4-mapped, in the dotted form DNS returns and the hex form URL emits.
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:169.254.169.254',
  '::ffff:a9fe:a9fe',
  '::ffff:c000:c0',
  '0:0:0:0:0:ffff:a9fe:a9fe',
  '::FFFF:A9FE:A9FE',
  // IPv4-compatible (deprecated).
  '::127.0.0.1',
  '::7f00:1',
  // NAT64 well-known prefix.
  '64:ff9b::a9fe:a9fe',
  '64:ff9b::10.0.0.1',
])('classifies %s as private', (address) => {
  expect(isPrivateNetworkAddress(address)).toBe(true);
});

test.each([
  '8.8.8.8',
  '1.1.1.1',
  '100.128.0.1',
  '172.32.0.1',
  '192.0.1.1',
  '192.169.0.1',
  // Fake-IP DNS pool of TUN-mode proxies; only the gateway proxy blocks it.
  '198.18.0.1',
  '::ffff:c612:1',
  '2606:4700:4700::1111',
  '::ffff:8.8.8.8',
  '::ffff:808:808',
  '64:ff9b::808:808',
])('classifies %s as public', (address) => {
  expect(isPrivateNetworkAddress(address)).toBe(false);
});

test.each(['', 'localhost', 'example.com'])(
  'leaves non-IP input %j to the caller',
  (value) => {
    expect(isPrivateNetworkAddress(value)).toBe(false);
  },
);
