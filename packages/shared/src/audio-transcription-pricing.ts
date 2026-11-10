export const AUDIO_TRANSCRIPTION_COST_USD_PER_SECOND: {
  readonly openaiWhisper: number;
  readonly deepgramNova3: number;
  readonly assemblyaiUniversal: number;
} = {
  openaiWhisper: 0.006 / 60,
  deepgramNova3: 0.0077 / 60,
  assemblyaiUniversal: 0.21 / 3600,
};

export function estimateAudioTranscriptionCostUsd(params: {
  provider: string;
  model: string;
  audioSeconds: number;
}): number | undefined {
  const provider = String(params.provider || '').toLowerCase();
  const model = String(params.model || '').toLowerCase();
  let rate: number | undefined;
  if (provider === 'openai') {
    rate = AUDIO_TRANSCRIPTION_COST_USD_PER_SECOND.openaiWhisper;
  } else if (provider === 'deepgram' && model.includes('nova')) {
    rate = AUDIO_TRANSCRIPTION_COST_USD_PER_SECOND.deepgramNova3;
  } else if (provider === 'assemblyai') {
    rate = AUDIO_TRANSCRIPTION_COST_USD_PER_SECOND.assemblyaiUniversal;
  }
  return rate == null
    ? undefined
    : Number((params.audioSeconds * rate).toFixed(6));
}
