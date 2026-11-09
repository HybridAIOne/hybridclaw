export function classifyProviderError(err) {
  const text = err instanceof Error ? err.message : String(err);
  // A provider's HTTP status decides; counts in its message, such as a
  // 400 for 512 tools, are not statuses.
  const status = /Provider API error (\d{3})\b/.exec(text)?.[1] ?? text;
  if (/(^|\D)401(\D|$)|(^|\D)403(\D|$)/.test(status)) return 'auth';
  if (
    /unauthorized|forbidden|invalid api key|missing api key|no api key|api key.*required|credentials?.*not configured|permission denied/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (/(^|\D)429(\D|$)/.test(status)) return 'rate_limit';
  if (/rate[- ]?limit|too many requests|quota|billing/i.test(text)) {
    return 'rate_limit';
  }
  if (/(^|\D)5\d\d(\D|$)/.test(status)) return 'server_error';
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
