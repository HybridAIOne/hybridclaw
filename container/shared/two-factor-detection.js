export const TWO_FACTOR_MODALITIES = [
  'totp',
  'push',
  'qr',
  'sms',
  'recovery_code',
];

export const EXTRACT_TEXT_PREVIEW_FUNCTION_SOURCE = `() => {
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const normalized = bodyText
    .replace(/\\r/g, '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const previewLimit = 6000;
  return {
    url: String(window.location.href || ''),
    title: String(document.title || ''),
    text_length: normalized.length,
    preview: normalized.slice(0, previewLimit),
    preview_truncated: normalized.length > previewLimit,
    has_noscript: Boolean(document.querySelector('noscript')),
    root_shell: Boolean(document.querySelector('div#root:empty, div#app:empty, div#__next:empty')),
    ready_state: String(document.readyState || ''),
  };
}`;

export const EXTRACT_TEXT_PREVIEW_SCRIPT = `(${EXTRACT_TEXT_PREVIEW_FUNCTION_SOURCE})()`;

export const TWO_FACTOR_SELECTOR_HINTS_FUNCTION_SOURCE = `() => {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ];
  return selectors.filter((selector) => document.querySelector(selector));
}`;

export const TWO_FACTOR_SELECTOR_HINTS_SCRIPT = `(${TWO_FACTOR_SELECTOR_HINTS_FUNCTION_SOURCE})()`;

export const EXTRACT_TWO_FACTOR_PAGE_STATE_FUNCTION_SOURCE = `() => {
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const normalized = bodyText
    .replace(/\\r/g, '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ].filter((selector) => document.querySelector(selector));
  return {
    url: String(window.location.href || ''),
    title: String(document.title || ''),
    preview: normalized.slice(0, 6000),
    textLength: normalized.length,
    previewTruncated: normalized.length > 6000,
    hasNoscript: Boolean(document.querySelector('noscript')),
    rootShell: Boolean(document.querySelector('div#root:empty, div#app:empty, div#__next:empty')),
    readyState: String(document.readyState || ''),
    selectors,
  };
}`;

export const EXTRACT_TWO_FACTOR_PAGE_STATE_SCRIPT = `(${EXTRACT_TWO_FACTOR_PAGE_STATE_FUNCTION_SOURCE})()`;

const TWO_FACTOR_MODALITY_SET = new Set(TWO_FACTOR_MODALITIES);

const TWO_FACTOR_TEXT_PATTERNS = [
  {
    modality: 'totp',
    pattern: /\b(authenticator|totp)\b/i,
    signal: 'totp text',
  },
  {
    modality: 'push',
    pattern: /\b(push|approve.+device)\b/i,
    signal: 'push text',
  },
  { modality: 'qr', pattern: /\b(qr|scan.+code)\b/i, signal: 'qr text' },
  { modality: 'sms', pattern: /\b(sms|text message)\b/i, signal: 'sms text' },
  {
    modality: 'recovery_code',
    pattern: /\b(recovery code|backup code)\b/i,
    signal: 'recovery-code text',
  },
];

export function normalizeTwoFactorModality(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return TWO_FACTOR_MODALITY_SET.has(normalized) ? normalized : null;
}

export function hasExpectedTwoFactorWaypoint(args) {
  return args.expects_2fa === true;
}

export function llmSignaledTwoFactor(args) {
  const signal = [
    args.llmSignal,
    args.llm_signal,
    args.twoFactorSignal,
    args.two_factor_signal,
  ]
    .filter((value) => typeof value === 'string')
    .join('\n');
  return /\b(stuck.+(2fa|two[- ]factor|verification code)|2fa page|two[- ]factor page|mfa page)\b/i.test(
    signal,
  );
}

export function detectTwoFactorChallenge(input) {
  const args = input.args || {};
  const signals = [];
  const selectors = input.selectors || [];
  for (const selector of selectors) {
    const normalized = selector.toLowerCase();
    if (
      normalized.includes('autocomplete="one-time-code"') ||
      normalized.includes("autocomplete='one-time-code'") ||
      normalized.includes('input[autocomplete=one-time-code]') ||
      normalized.includes('input[type="tel"]') ||
      normalized.includes("input[type='tel']") ||
      normalized.includes('input[type=tel]') ||
      normalized.includes('inputmode="numeric"') ||
      normalized.includes("inputmode='numeric'") ||
      normalized.includes('inputmode=numeric') ||
      normalized.includes('name*="otp"') ||
      normalized.includes("name*='otp'") ||
      normalized.includes('id*="otp"') ||
      normalized.includes("id*='otp'") ||
      normalized.includes('name*="code"') ||
      normalized.includes("name*='code'") ||
      normalized.includes('id*="code"') ||
      normalized.includes("id*='code'")
    ) {
      signals.push(`selector:${selector}`);
    }
  }

  const text = [input.title, input.text].filter(Boolean).join('\n');
  let modality = normalizeTwoFactorModality(args.modality);
  for (const entry of TWO_FACTOR_TEXT_PATTERNS) {
    if (entry.pattern.test(text)) {
      signals.push(entry.signal);
      modality ||= entry.modality;
      break;
    }
  }
  if (
    /\b(verification code|one[- ]time code|two[- ]factor|2fa|multi[- ]factor)\b/i.test(
      text,
    )
  ) {
    signals.push('generic 2fa text');
  }
  if (hasExpectedTwoFactorWaypoint(args)) {
    signals.push('skill waypoint expects_2fa');
  }
  if (llmSignaledTwoFactor(args)) {
    signals.push('llm 2fa signal');
  }

  return {
    detected: signals.length > 0,
    modality: signals.length > 0 ? modality || 'totp' : null,
    signals,
    selectors,
    ...(input.text ? { textPreview: input.text } : {}),
  };
}
