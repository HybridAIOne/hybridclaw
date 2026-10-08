/**
 * G.711 µ-law ↔ 16-bit linear PCM companding for 8 kHz telephony audio.
 *
 * Pure per-sample transforms — no resampling, no buffering, no I/O — so a
 * transport speaking linear PCM (Vonage websocket L16) can bridge to a
 * realtime session speaking `audio/pcmu` without quality-degrading rate
 * conversion. Buffers are 16-bit little-endian mono.
 *
 * NOT a media pipeline: pacing, framing, and base64 wrapping belong to the
 * transport owners (`plugin-realtime-voice.ts`, channel runtimes).
 */

const BIAS = 0x84;
const CLIP = 32_635;

const ENCODE_EXPONENT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  if (i < 2) ENCODE_EXPONENT_TABLE[i] = 0;
  else if (i < 4) ENCODE_EXPONENT_TABLE[i] = 1;
  else if (i < 8) ENCODE_EXPONENT_TABLE[i] = 2;
  else if (i < 16) ENCODE_EXPONENT_TABLE[i] = 3;
  else if (i < 32) ENCODE_EXPONENT_TABLE[i] = 4;
  else if (i < 64) ENCODE_EXPONENT_TABLE[i] = 5;
  else if (i < 128) ENCODE_EXPONENT_TABLE[i] = 6;
  else ENCODE_EXPONENT_TABLE[i] = 7;
}

export function muLawEncodeSample(sample: number): number {
  let value = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  if (value > CLIP) value = CLIP;
  value += BIAS;
  const exponent = ENCODE_EXPONENT_TABLE[(value >> 7) & 0xff];
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function muLawDecodeSample(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  // The negative-zero code (0x7f) decodes to plain 0, not -0.
  return sign && magnitude ? -magnitude : magnitude;
}

/** 16-bit LE mono PCM → µ-law, one byte per sample. */
export function pcm16ToMuLaw(pcm: Buffer): Buffer {
  const sampleCount = Math.floor(pcm.length / 2);
  const out = Buffer.allocUnsafe(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = muLawEncodeSample(pcm.readInt16LE(i * 2));
  }
  return out;
}

/** µ-law → 16-bit LE mono PCM, two bytes per sample. */
export function muLawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(muLawDecodeSample(mulaw[i]), i * 2);
  }
  return out;
}
