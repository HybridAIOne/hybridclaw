/**
 * Private-network IP classifier for SSRF guards: one range table applied to URL
 * IP literals and DNS answers alike. IPv6 forms that reach an IPv4 host
 * (IPv4-mapped, which URL serializes as hex like `::ffff:a9fe:a9fe`;
 * IPv4-compatible; NAT64) are judged by that IPv4 address. Takes a bare IP and
 * returns false for anything else, so callers strip URL brackets and resolve
 * names first. Says nothing about allowlists; that is `network-policy.js`.
 */
import net from 'node:net';

// 192.0.0.0/24 in, 198.18.0.0/15 out (owner-delegated call, 2026-09-23): the
// benchmarking range doubles as the fake-IP DNS pool of Clash, Surge, and
// sing-box TUN modes, so blocking it here would block all browsing for their
// users. The gateway's secret-injecting http_request proxy blocks it itself.
const PRIVATE_IPV4_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12],
  // IETF protocol assignments; 192.0.0.192 is Oracle Cloud Classic metadata.
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3], // multicast, reserved, broadcast
];

const privateNetworks = new net.BlockList();
for (const [network, prefix] of PRIVATE_IPV4_SUBNETS) {
  // check() also matches IPv4-mapped IPv6 addresses against IPv4 subnets.
  privateNetworks.addSubnet(network, prefix, 'ipv4');
  // NAT64 well-known prefix (RFC 6052): the translator dials the IPv4 host.
  privateNetworks.addSubnet(`64:ff9b::${network}`, 96 + prefix, 'ipv6');
}
// ::/96 is the unspecified and loopback addresses plus the deprecated
// IPv4-compatible form (::a.b.c.d); none of it is a public destination.
privateNetworks.addSubnet('::', 96, 'ipv6');
privateNetworks.addSubnet('fc00::', 7, 'ipv6'); // unique local
privateNetworks.addSubnet('fe80::', 10, 'ipv6'); // link-local

export function isPrivateNetworkAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return privateNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
