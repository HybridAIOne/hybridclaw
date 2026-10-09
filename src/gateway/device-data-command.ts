/**
 * `/device-data` — how a companion app replaces what the user's phone shares
 * (`device-data.ts`). Apps send it as an ordinary chat turn; a known command
 * never reaches the model and is not stored in the chat's history.
 *
 * The payload is one token: `{"sources": {...}}` compressed with raw DEFLATE
 * and encoded as base64url. Chat splits a command on white space, which would
 * change the text inside JSON, and relays that log the start of a message then
 * keep no readable personal text. It is not encryption.
 */
import { inflateRawSync } from 'node:zlib';
import { parseLowerArg } from '../command-parsing.js';
import {
  clearDeviceSources,
  DeviceDataError,
  MAX_DEVICE_SOURCE_BYTES,
  MAX_DEVICE_SOURCES,
  MAX_LARGE_SOURCE_BYTES,
  readDeviceSources,
  writeDeviceSources,
} from './device-data.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

const USAGE =
  'Usage: `device-data set <payload>`, `device-data show`, `device-data clear`. `<payload>` is `{"sources": {"<id>": "<text>" | null}}` compressed with raw DEFLATE and encoded as base64url. Add `--json` for a machine-readable answer.';
// Every source at its limit, with room for JSON escaping.
const MAX_INFLATED_BYTES =
  ((MAX_DEVICE_SOURCES - 2) * MAX_DEVICE_SOURCE_BYTES +
    2 * MAX_LARGE_SOURCE_BYTES) *
  2;
const PAYLOAD = /^[A-Za-z0-9_-]+$/;

function decodePayload(token: string): unknown {
  if (!PAYLOAD.test(token)) {
    throw new DeviceDataError('The payload is not base64url.');
  }
  let json: string;
  try {
    json = inflateRawSync(Buffer.from(token, 'base64url'), {
      maxOutputLength: MAX_INFLATED_BYTES,
    }).toString('utf8');
  } catch {
    throw new DeviceDataError('The payload is not raw DEFLATE, or too large.');
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new DeviceDataError('The payload is not JSON.');
  }
}

function answer(
  sources: string[],
  json: boolean,
  userId: string | null | undefined,
): GatewayCommandResult {
  if (json) return plainCommand(chatSafeJson({ version: 1, sources }));
  if (sources.length === 0) return plainCommand('Your phone shares nothing.');
  const kept = readDeviceSources(userId);
  return plainCommand(
    `Your phone shares: ${sources
      .map((id) => `${id} (updated ${kept[id]?.updatedAt ?? 'unknown'})`)
      .join(', ')}.`,
  );
}

export function handleDeviceDataCommand(
  req: GatewayCommandRequest,
): GatewayCommandResult {
  const sub = parseLowerArg(req.args, 1);
  const rest = req.args.slice(2).map(String);
  const json = rest.includes('--json');
  const operands = rest.filter((arg) => arg !== '--json');
  try {
    if (sub === 'set' && operands.length === 1) {
      const body = decodePayload(operands[0]) as { sources?: unknown } | null;
      const kept = writeDeviceSources(req.userId, body?.sources);
      return answer(kept, json, req.userId);
    }
    if (sub === 'show' && operands.length === 0) {
      return answer(
        Object.keys(readDeviceSources(req.userId)).sort(),
        json,
        req.userId,
      );
    }
    if (sub === 'clear' && operands.length === 0) {
      clearDeviceSources(req.userId);
      return answer([], json, req.userId);
    }
  } catch (error) {
    if (error instanceof DeviceDataError) {
      return badCommand('Device Data', error.message);
    }
    throw error;
  }
  return badCommand('Usage', USAGE);
}
