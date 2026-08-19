/**
 * Browser audio pipeline for realtime voice: microphone capture as base64
 * PCM16 mono 24 kHz chunks, and gapless scheduled playback of the same wire
 * format, with instant clear-on-barge-in.
 *
 * Capture uses a ScriptProcessorNode instead of an AudioWorklet on purpose:
 * the console ships under `script-src 'self'` and this avoids a separately
 * emitted worklet asset for ~10 lines of resampling. Swap to a worklet if the
 * deprecation ever lands in practice.
 *
 * NOT the session protocol: websocket frames live in `use-voice-session.ts`.
 */

export const VOICE_SAMPLE_RATE = 24_000;
const CAPTURE_BUFFER_SIZE = 4096;

function floatTo16BitPcmBase64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    samples[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
  }
  return samples;
}

function resampleLinear(
  input: Float32Array<ArrayBuffer>,
  fromRate: number,
  toRate: number,
): Float32Array<ArrayBuffer> {
  if (fromRate === toRate) return input;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(outLength);
  const step = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * step;
    const low = Math.floor(pos);
    const high = Math.min(input.length - 1, low + 1);
    const frac = pos - low;
    output[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return output;
}

export class VoiceAudioPipeline {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playbackCursor = 0;
  private readonly playingSources = new Set<AudioBufferSourceNode>();

  async start(onChunk: (base64Pcm: string) => void): Promise<void> {
    if (this.context) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Some hardware ignores the requested rate; capture resamples from
    // context.sampleRate to the 24 kHz wire rate either way.
    const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    this.context = context;
    await context.resume();
    this.source = context.createMediaStreamSource(this.stream);
    this.processor = context.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(
        new Float32Array(input),
        context.sampleRate,
        VOICE_SAMPLE_RATE,
      );
      onChunk(floatTo16BitPcmBase64(resampled));
    };
    this.source.connect(this.processor);
    // Chrome requires the processor to reach the destination to fire
    // onaudioprocess; a zero-gain node keeps the mic out of the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(context.destination);
  }

  playAudio(base64Pcm: string): void {
    const context = this.context;
    if (!context) return;
    const samples = base64ToFloat32(base64Pcm);
    if (samples.length === 0) return;
    const wireRateBuffer = context.createBuffer(
      1,
      samples.length,
      VOICE_SAMPLE_RATE,
    );
    wireRateBuffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = wireRateBuffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.playbackCursor);
    source.start(startAt);
    this.playbackCursor = startAt + wireRateBuffer.duration;
    this.playingSources.add(source);
    source.onended = () => {
      this.playingSources.delete(source);
    };
  }

  clearPlayback(): void {
    for (const source of this.playingSources) {
      try {
        source.stop();
      } catch {
        // Already ended; nothing to stop.
      }
    }
    this.playingSources.clear();
    this.playbackCursor = 0;
  }

  stop(): void {
    this.clearPlayback();
    this.processor?.disconnect();
    this.processor = null;
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() || []) {
      track.stop();
    }
    this.stream = null;
    void this.context?.close().catch(() => {
      // The context may already be closed by the browser.
    });
    this.context = null;
  }
}
