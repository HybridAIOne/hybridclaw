// What the agent's browser is looking at, and whether the next browser call
// would buy something. Browser tools record the page here; the approval
// policy reads it, because a click carries only a ref like `@e12` and the
// button's label lives in the last snapshot.

export interface BrowserRefLabel {
  role: string;
  name: string;
}

export interface BrowserPageState {
  url: string;
  title: string;
  refs: Map<string, BrowserRefLabel>;
  /** Set after a secret was typed; live frames stay off until the URL changes. */
  framesPaused: boolean;
}

export interface CheckoutAction {
  host: string;
  /** The button's own words, or '' when the click target has no label. */
  label: string;
  url: string;
}

const state: BrowserPageState = {
  url: '',
  title: '',
  refs: new Map(),
  framesPaused: false,
};

export function currentBrowserPage(): Readonly<BrowserPageState> {
  return state;
}

export function recordBrowserPage(update: {
  url?: unknown;
  title?: unknown;
}): void {
  const url = typeof update.url === 'string' ? update.url.trim() : '';
  if (url && url !== state.url) {
    state.url = url;
    // Refs belong to the page they were read from, and a typed secret to the
    // form it was typed into.
    state.refs = new Map();
    state.framesPaused = false;
  }
  if (typeof update.title === 'string') state.title = update.title.trim();
}

export function recordBrowserSnapshotRefs(refs: unknown): void {
  const next = new Map<string, BrowserRefLabel>();
  if (refs && typeof refs === 'object') {
    for (const [key, value] of Object.entries(refs)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      next.set(normalizeRef(key), {
        role: typeof entry.role === 'string' ? entry.role : '',
        name: typeof entry.name === 'string' ? entry.name : '',
      });
    }
  }
  state.refs = next;
}

export function pauseBrowserFramesUntilNavigation(): void {
  state.framesPaused = true;
}

export function resetBrowserPage(): void {
  state.url = '';
  state.title = '';
  state.refs = new Map();
  state.framesPaused = false;
}

function normalizeRef(raw: string): string {
  return raw.trim().replace(/^@/, '').replace(/^ref=/, '');
}

// Words on the last button of a checkout: they commit money. German shops must
// label it "zahlungspflichtig bestellen" or an equally clear phrase
// (§ 312j BGB), so those wordings are listed in full. "Checkout" and "Proceed
// to checkout" only open the checkout and are deliberately absent.
const PURCHASE_LABEL_RE = new RegExp(
  [
    '^place (?:your |my |the )?order',
    '^(?:buy|purchase)(?: now| it now| for)?(?:$|\\s|\\W)',
    '^(?:complete|confirm|finish|submit) (?:the |your |my )?(?:purchase|order|payment|booking)',
    '^confirm (?:and|&) (?:pay|buy|book|order)',
    '^pay(?: now| securely| with|$|\\s+[$€£]|\\s+\\d)',
    '^(?:book|reserve) now',
    '^(?:subscribe|start (?:my |your )?subscription) (?:and|&|for|now)',
    '^(?:zahlungs|kosten)pflichtig (?:bestellen|buchen|abonnieren|kaufen)',
    '^jetzt (?:kaufen|bestellen|buchen|bezahlen|zahlen)',
    '^(?:kaufen|bestellen|bezahlen)$',
    '^(?:bestellung|kauf|buchung|zahlung) (?:abschließen|abschicken|absenden|bestätigen)',
    '^(?:kauf|bestellung) (?:jetzt )?abschließen',
    '^(?:acheter|commander)(?: et payer| maintenant)?$',
  ].join('|'),
  'i',
);

// A page that is itself a checkout step. There, a click whose target the
// agent cannot name, or Enter, may be the one that buys.
const CHECKOUT_SEGMENT_RE =
  /^(?:checkout(?:[-_](?:payment|review|confirm|summary))?|payment|kasse|bezahlen|zahlung|zahlungsart|place-?order|order-?review|confirm-?order|spc)(?:\.\w{2,5})?$/i;

export function isPurchaseLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 80) return false;
  return PURCHASE_LABEL_RE.test(normalized);
}

export function isCheckoutPage(url: string): boolean {
  try {
    return new URL(url).pathname
      .split('/')
      .some((segment) => CHECKOUT_SEGMENT_RE.test(segment));
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function clickLabel(args: Record<string, unknown>): string | null {
  if (typeof args.text === 'string' && args.text.trim()) {
    return args.text.trim();
  }
  if (typeof args.ref === 'string' && args.ref.trim()) {
    const known = state.refs.get(normalizeRef(args.ref));
    return known?.name.trim() || null;
  }
  if (typeof args.selector === 'string') {
    // `text=Place order`, `button:has-text("Buy now")`, …
    const quoted = args.selector.match(
      /(?:text=|has-text\(|:contains\()\s*["']?([^"')]+)/i,
    );
    if (quoted?.[1]) return quoted[1].trim();
  }
  return null;
}

// Ids and classes shops give the final button (`#placeOrder`, `.buy-now`).
const PURCHASE_SELECTOR_RE =
  /(?:place|submit|confirm)[-_]?order|buy[-_]?now|pay[-_]?now|complete[-_]?purchase|checkout[-_]?submit/i;

const ENTER_KEYS = new Set(['enter', 'return', 'numpadenter']);

/**
 * The checkout this browser call would complete, or `null`.
 *
 * A click is a purchase when its label says so. On a checkout page, a click
 * the agent cannot name (coordinates, a ref from an older snapshot) and Enter
 * count too: there the cheap mistake is asking once too often.
 */
export function classifyBrowserCheckout(
  toolName: string,
  args: Record<string, unknown>,
): CheckoutAction | null {
  const tool = toolName.toLowerCase();
  const url = state.url;
  const host = hostOf(url);
  if (tool === 'browser_click') {
    const label = clickLabel(args);
    if (label && isPurchaseLabel(label)) {
      return { host, label, url };
    }
    if (
      typeof args.selector === 'string' &&
      PURCHASE_SELECTOR_RE.test(args.selector)
    ) {
      return { host, label: label || '', url };
    }
    if (label === null && isCheckoutPage(url)) {
      return { host, label: '', url };
    }
    return null;
  }
  if (tool === 'browser_press') {
    const key = String(args.key || '')
      .trim()
      .toLowerCase();
    if (ENTER_KEYS.has(key) && isCheckoutPage(url)) {
      return { host, label: '', url };
    }
  }
  return null;
}
