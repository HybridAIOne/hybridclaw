export const TWO_FACTOR_MODALITIES = [
  'totp',
  'push',
  'qr',
  'sms',
  'recovery_code',
];

const EXTRACT_TEXT_PREVIEW_FUNCTION_SOURCE = `() => {
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
    modality: 'push',
    pattern:
      /\b(approve (the |this |your )?(sign[- ]?in|log[- ]?in)( request)?|(sign[- ]?in|log[- ]?in) request|push notification|tap yes|sent a notification to|approve.+device)\b/i,
    signal: 'push text',
  },
  {
    modality: 'totp',
    pattern: /\b(authenticator|totp)\b/i,
    signal: 'totp text',
  },
  { modality: 'qr', pattern: /\b(qr|scan.+code)\b/i, signal: 'qr text' },
  {
    modality: 'sms',
    pattern: /\b(sms|text message|sent (a |an? \d[- ]digit )?code to)\b/i,
    signal: 'sms text',
  },
  {
    modality: 'recovery_code',
    pattern: /\b(recovery code|backup code)\b/i,
    signal: 'recovery-code text',
  },
];

// Words that ask for a code or an approval. A card's "verification code" is
// its CVC, so it does not count.
const TWO_FACTOR_CHALLENGE_TEXT =
  /\b((?<!card )verification code|one[- ]time (pass)?code|one[- ]time password|authentication code|(sign[- ]?in|log[- ]?in) code|two[- ]factor|(two|2)[- ]step (verification|authentication)|2fa|multi[- ]factor|authenticator app|approve (the |this |your )?(sign[- ]?in|log[- ]?in)|bestätigungscode|verifizierungscode|einmalcode|einmalpasswort|anmeldecode|authentifizierungscode|(zwei|2)[- ]faktor|zwei[- ]schritt[- ]?(verifizierung|bestätigung|authentifizierung))\b/i;

// A page with no code field asks for an approval only when it is about little
// else; a home page that mentions two-factor sign-in is not a challenge.
const TWO_FACTOR_SHORT_PAGE_CHARS = 2000;

function isOneTimeCodeSelector(normalized) {
  return (
    normalized.includes('autocomplete="one-time-code"') ||
    normalized.includes("autocomplete='one-time-code'") ||
    normalized.includes('input[autocomplete=one-time-code]') ||
    normalized.includes('name*="otp"') ||
    normalized.includes("name*='otp'") ||
    normalized.includes('id*="otp"') ||
    normalized.includes("id*='otp'")
  );
}

// Fields a code could go in, but so could a phone number, a postcode or a
// voucher.
function isCodeLikeSelector(normalized) {
  return (
    normalized.includes('input[type="tel"]') ||
    normalized.includes("input[type='tel']") ||
    normalized.includes('input[type=tel]') ||
    normalized.includes('inputmode="numeric"') ||
    normalized.includes("inputmode='numeric'") ||
    normalized.includes('inputmode=numeric') ||
    normalized.includes('name*="code"') ||
    normalized.includes("name*='code'") ||
    normalized.includes('id*="code"') ||
    normalized.includes("id*='code'")
  );
}

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

/**
 * Whether the page waits for a second factor. A one-time-code field, a skill
 * waypoint or the model's own signal is enough. A phone, numeric or "code"
 * field counts only next to words that ask for a code, and those words alone
 * only on a short page: a parked page stops the agent until a code arrives, so
 * an order form or a home page that mentions "push" must not park.
 */
export function detectTwoFactorChallenge(input) {
  const args = input.args || {};
  const signals = [];
  const selectors = input.selectors || [];
  let oneTimeCodeField = false;
  let codeLikeField = false;
  for (const selector of selectors) {
    const normalized = selector.toLowerCase();
    if (isOneTimeCodeSelector(normalized)) {
      oneTimeCodeField = true;
    } else if (isCodeLikeSelector(normalized)) {
      codeLikeField = true;
    } else {
      continue;
    }
    signals.push(`selector:${selector}`);
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
  const asksForCode = TWO_FACTOR_CHALLENGE_TEXT.test(text);
  if (asksForCode) {
    signals.push('generic 2fa text');
  }
  const expected = hasExpectedTwoFactorWaypoint(args);
  if (expected) {
    signals.push('skill waypoint expects_2fa');
  }
  const signaled = llmSignaledTwoFactor(args);
  if (signaled) {
    signals.push('llm 2fa signal');
  }

  const detected =
    expected ||
    signaled ||
    oneTimeCodeField ||
    (asksForCode &&
      (codeLikeField || text.length <= TWO_FACTOR_SHORT_PAGE_CHARS));
  return {
    detected,
    modality: detected ? modality || 'totp' : null,
    signals: detected ? signals : [],
    selectors,
    ...(input.text ? { textPreview: input.text } : {}),
  };
}
