export function classifyProviderError(err) {
  const text = err instanceof Error ? err.message : String(err);
  if (/(^|\D)401(\D|$)|(^|\D)403(\D|$)/.test(text)) return 'auth';
  if (
    /unauthorized|forbidden|invalid api key|missing api key|no api key|api key.*required|credentials?.*not configured|permission denied/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (/(^|\D)429(\D|$)/.test(text)) return 'rate_limit';
  if (/rate[- ]?limit|too many requests|quota|billing/i.test(text)) {
    return 'rate_limit';
  }
  if (/(^|\D)5\d\d(\D|$)/.test(text)) return 'server_error';
  if (
    /internal server error|bad gateway|service unavailable|gateway timeout/i.test(
      text,
    )
  ) {
    return 'server_error';
  }
  return 'other';
}

export function shouldFallbackProviderError(err) {
  return classifyProviderError(err) !== 'other';
}
