function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function truncateHeadTailText(params: {
  text: string;
  maxChars: number;
  marker: string;
  headRatio: number;
  tailRatio: number;
}): string {
  const { text, marker } = params;
  if (text.length <= params.maxChars) return text;

  const maxChars = Math.max(0, Math.floor(params.maxChars));
  if (maxChars <= 0) return '';

  const available = maxChars - marker.length;
  if (available <= 0) return text.slice(0, maxChars);

  const headRatio = clamp(params.headRatio, 0, 1);
  const tailRatio = clamp(params.tailRatio, 0, 1);
  let headChars = Math.floor(available * headRatio);
  let tailChars = Math.floor(available * tailRatio);

  if (headChars + tailChars > available) {
    tailChars = Math.max(0, available - headChars);
  } else {
    headChars += available - (headChars + tailChars);
  }

  if (tailChars <= 0) return `${text.slice(0, headChars)}${marker}`;
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}
