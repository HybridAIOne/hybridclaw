import { expect, test } from 'vitest';
import {
  muLawDecodeSample,
  muLawEncodeSample,
  muLawToPcm16,
  pcm16ToMuLaw,
} from '../src/channels/voice/audio-codec.js';

test('known G.711 anchor points', () => {
  expect(muLawEncodeSample(0)).toBe(0xff);
  expect(muLawDecodeSample(0xff)).toBe(0);
  // Full-scale positive clips to the µ-law maximum code (0x80).
  expect(muLawEncodeSample(32_767)).toBe(0x80);
  expect(muLawDecodeSample(0x80)).toBe(32_124);
  expect(muLawDecodeSample(0x00)).toBe(-32_124);
});

test('every µ-law code survives a decode/encode round trip', () => {
  for (let code = 0; code < 256; code++) {
    const sample = muLawDecodeSample(code);
    const reencoded = muLawEncodeSample(sample);
    expect(muLawDecodeSample(reencoded)).toBe(sample);
  }
});

test('companding is symmetric and monotonic on a ramp', () => {
  for (let value = 517; value <= 32_000; value += 517) {
    expect(muLawDecodeSample(muLawEncodeSample(-value))).toBe(
      -muLawDecodeSample(muLawEncodeSample(value)),
    );
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (let value = -32_768; value <= 32_767; value += 129) {
    const decoded = muLawDecodeSample(muLawEncodeSample(value));
    expect(decoded).toBeGreaterThanOrEqual(previous);
    previous = decoded;
  }
});

test('buffer transforms are inverse-consistent and size-correct', () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(1_000, 2);
  pcm.writeInt16LE(-1_000, 4);
  pcm.writeInt16LE(31_000, 6);

  const mulaw = pcm16ToMuLaw(pcm);
  expect(mulaw.length).toBe(4);
  const roundTrip = pcm16ToMuLaw(muLawToPcm16(mulaw));
  expect(roundTrip.equals(mulaw)).toBe(true);
});
