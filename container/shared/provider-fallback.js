export function classifyProviderError(err) {
  const text = err instanceof Error ? err.message : String(err);
  if (/(^|\D)401(\D|$)|(^|\D)403(\D|$)/.test(text)) return 'auth';
  if (/unauthorized|forbidden|invalid api key|permission denied/i.test(text)) {
    return 'auth';
  }
  if (/(^|\D)429(\D|$)/.test(text)) return 'rate_limit';
  if (/rate[- ]?limit|too many requests|quota|billing/i.test(text)) {
    return 'rate_limit';
  }
  return 'other';
}

export function shouldFallbackProviderError(err) {
  return classifyProviderError(err) !== 'other';
}
