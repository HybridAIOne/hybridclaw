function isoDate(value, fieldName) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  throw new Error(`Invoice payload is missing valid ${fieldName}.`);
}

function periodFromDate(value) {
  return isoDate(value, 'period date').slice(0, 7);
}

function sinceTimestamp(options, label = 'invoice since date') {
  if (!options || !options.since) return null;
  const timestamp = new Date(options.since).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label}: ${options.since}`);
  }
  return timestamp;
}

function invoiceIssuePeriod(options) {
  const timestamp = sinceTimestamp(options, 'invoice since date') ?? Date.now();
  const start = new Date(timestamp);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  const end = new Date(Date.UTC(year, month, 0));
  const googleAdsMonths = [
    'JANUARY',
    'FEBRUARY',
    'MARCH',
    'APRIL',
    'MAY',
    'JUNE',
    'JULY',
    'AUGUST',
    'SEPTEMBER',
    'OCTOBER',
    'NOVEMBER',
    'DECEMBER',
  ];
  return {
    year,
    month,
    googleAdsMonth: googleAdsMonths[month - 1],
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function parseInvoiceMoneyText(value) {
  const compact = value.replace(/[^0-9,.-]/g, '');
  if (!/\d/u.test(compact)) {
    throw new Error(`Unable to parse invoice money value: ${value}`);
  }
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  let decimalSeparator = '';

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastDot > lastComma ? '.' : ',';
  } else {
    const separator = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : '';
    if (separator) {
      const firstIndex = compact.indexOf(separator);
      const lastIndex = compact.lastIndexOf(separator);
      if (firstIndex === lastIndex) {
        const digitsAfter = compact.slice(lastIndex + 1).replace(/\D/g, '').length;
        const digitsBefore = compact.slice(0, lastIndex).replace(/\D/g, '').length;
        decimalSeparator =
          digitsAfter === 3 && digitsBefore > 0 ? '' : separator;
      }
    }
  }

  let normalized = compact;
  if (decimalSeparator) {
    const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
    normalized = normalized.split(thousandsSeparator).join('');
    if (decimalSeparator === ',') normalized = normalized.replace(',', '.');
  } else {
    normalized = normalized.replace(/[.,]/g, '');
  }
  normalized = normalized.replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to parse invoice money value: ${value}`);
  }
  return parsed;
}

function moneyFromMicros(value) {
  const numeric =
    typeof value === 'string' ? Number.parseFloat(value) : Number(value || 0);
  return Number((numeric / 1_000_000).toFixed(2));
}

function moneyFromDecimal(value) {
  const numeric =
    typeof value === 'string' ? Number.parseFloat(value) : Number(value || 0);
  return Number(numeric.toFixed(2));
}

function vatRate(net, vat) {
  return net > 0 ? Number((vat / net).toFixed(4)) : 0;
}

module.exports = {
  invoiceIssuePeriod,
  isoDate,
  moneyFromDecimal,
  moneyFromMicros,
  parseInvoiceMoneyText,
  periodFromDate,
  sinceTimestamp,
  vatRate,
};
