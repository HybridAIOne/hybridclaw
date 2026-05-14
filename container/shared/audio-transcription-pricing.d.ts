export const AUDIO_TRANSCRIPTION_COST_USD_PER_SECOND: {
  readonly openaiWhisper: number;
  readonly deepgramNova3: number;
  readonly assemblyaiUniversal: number;
};

export function estimateAudioTranscriptionCostUsd(params: {
  provider: string;
  model: string;
  audioSeconds: number;
}): number | undefined;
