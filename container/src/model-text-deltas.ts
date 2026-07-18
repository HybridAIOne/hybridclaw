export function createModelTextDeltaForwarder(params: {
  enabled: boolean;
  forwardLive: boolean;
  emit: (delta: string) => void;
}): {
  onProviderDelta: (delta: string) => void;
  emitFinalFallback: (text: string | null) => void;
} {
  let forwardedText = false;

  const forward = (text: string | null): void => {
    if (!params.enabled || !text) return;
    forwardedText = true;
    params.emit(text);
  };

  return {
    onProviderDelta(delta: string): void {
      if (!params.forwardLive) return;
      forward(delta);
    },
    emitFinalFallback(text: string | null): void {
      if (forwardedText) return;
      forward(text);
    },
  };
}
