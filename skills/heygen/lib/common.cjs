'use strict';

const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 60_000;
const RATE_LIMIT_BODY_RE =
  /rate.?limit|too many requests|quota exceeded|exceed rate limit|daily rate limit/i;
const INSUFFICIENT_CREDITS_RE = /insufficient credits/i;

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.max(0, Math.ceil(Number(raw) * 1_000));
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

function isRateLimitBody(body) {
  return RATE_LIMIT_BODY_RE.test(String(body || ''));
}

function parseIpv4Octets(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIpv4Octets(octets) {
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function ipv4OctetsFromMappedIpv6(hostname) {
  const dotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    return parseIpv4Octets(dotted[1]);
  }
  const packed = hostname.match(
    /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (!packed) {
    return null;
  }
  const high = Number.parseInt(packed[1], 16);
  const low = Number.parseInt(packed[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  if (net.isIP(normalized) === 4) {
    const octets = parseIpv4Octets(normalized);
    return octets ? isPrivateIpv4Octets(octets) : false;
  }
  if (net.isIP(normalized) === 6) {
    const mapped = ipv4OctetsFromMappedIpv6(normalized);
    if (mapped) return isPrivateIpv4Octets(mapped);
    return (
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd')
    );
  }
  return false;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  INSUFFICIENT_CREDITS_RE,
  RATE_LIMIT_BODY_RE,
  ipv4OctetsFromMappedIpv6,
  isPrivateHostname,
  isPrivateIpv4Octets,
  isRateLimitBody,
  parseIpv4Octets,
  parseRetryAfterMs,
};
