/**
 * `browser_take_over`: the user drives the agent's browser from their phone
 * while the agent waits, for a sign-in, a 2FA prompt, a CAPTCHA, or to show
 * the agent a task once.
 *
 * The tool opens a take-over on the gateway with the port of agent-browser's
 * own stream server (`src/gateway/browser-take-over.ts` relays it to the
 * phone), sets a phone-sized viewport, and waits until the user is done.
 * Meanwhile a small script in the page writes down what the user clicks,
 * chooses and types. Passwords, codes, card numbers and sign-in names are
 * never written down, only that something was typed. The steps reach the
 * model only when the user asks it to remember how they did it.
 */

export const TAKE_OVER_TOOL_NAME = 'browser_take_over';

const POLL_MS = 1_000;
// The phone has this long to open the browser before the agent gives up.
const CONNECT_TIMEOUT_MS = 3 * 60_000;
// The gateway's limit; the tool stops a little after it.
const TAKE_OVER_TIMEOUT_MS = 10 * 60_000 + 15_000;
const MAX_STEPS = 120;
// A phone's portrait screen in CSS pixels, drawn at twice the size.
const PHONE_VIEWPORT = { width: 400, height: 820, scale: 2 };

export interface TakeOverStep {
  kind: 'page' | 'click' | 'fill' | 'secret' | 'choose' | 'check' | 'press';
  label?: string;
  role?: string;
  value?: string;
  url?: string;
  title?: string;
  checked?: boolean;
}

export interface TakeOverDeps {
  /** One agent-browser command in this chat's browser session. */
  browser(
    command: string,
    args: string[],
  ): Promise<{ success: boolean; data?: unknown; error?: string }>;
  /** A POST to the gateway with its token; throws with the gateway's error. */
  gateway(path: string, body: Record<string, unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

// Installs itself once per document and hands back what it wrote down since
// the last call. It keeps its notes in sessionStorage so a click that leaves
// the page is still there on the next page of the same site.
export const TAKE_OVER_RECORDER_SCRIPT = String.raw`(() => {
  const KEY = '__hyTakeOverSteps';
  const load = () => {
    try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); }
    catch { return window[KEY] || []; }
  };
  const save = (steps) => {
    try { sessionStorage.setItem(KEY, JSON.stringify(steps.slice(-200))); }
    catch { window[KEY] = steps.slice(-200); }
  };
  const add = (step) => {
    const steps = load();
    steps.push({ ...step, page: location.origin + location.pathname });
    save(steps);
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const label = (el) => {
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const named = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (clean(named)) return clean(named);
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].textContent);
    if (clean(el.placeholder)) return clean(el.placeholder);
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    const inner = clean(el.innerText || el.textContent);
    if (inner) return inner;
    return clean(el.getAttribute('title') || el.getAttribute('alt') || el.name || el.id);
  };
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'dropdown';
    if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(el.type))) return 'button';
    if (tag === 'input' && ['checkbox', 'radio'].includes(el.type)) return el.type;
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return 'field';
    return tag;
  };
  // What is never written down: passwords, one-time codes, card details and
  // the name someone signs in with.
  const secret = (el) => {
    const auto = String(el.getAttribute('autocomplete') || '').toLowerCase();
    return el.type === 'password' || /password|one-time-code|cc-|username|webauthn/.test(auto);
  };
  if (!window.__hyTakeOverInstalled) {
    window.__hyTakeOverInstalled = true;
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const el = target.closest('a,button,input,select,textarea,label,summary,[role],[onclick],[tabindex]') || target;
      const kind = role(el);
      if (kind === 'field' || kind === 'dropdown' || kind === 'checkbox' || kind === 'radio') return;
      add({ kind: 'click', role: kind, label: label(el) });
    }, true);
    document.addEventListener('change', (event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      const kind = role(el);
      if (kind === 'checkbox' || kind === 'radio') {
        add({ kind: 'check', role: kind, label: label(el), checked: !!el.checked });
      } else if (kind === 'dropdown') {
        add({ kind: 'choose', label: label(el), value: clean(el.selectedOptions?.[0]?.textContent) });
      } else if (kind === 'field') {
        if (secret(el)) add({ kind: 'secret', label: label(el) });
        else add({ kind: 'fill', label: label(el), value: String(el.value ?? el.textContent ?? '').slice(0, 200) });
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.target instanceof Element)) return;
      add({ kind: 'press', label: label(event.target), value: 'Enter' });
    }, true);
  }
  const steps = load();
  save([]);
  return { url: location.href, title: document.title, steps };
})()`;

/**
 * A page script's notes as steps, with nothing but the known fields. A step's
 * `url` is the page it happened on.
 */
export function readRecordedSteps(raw: unknown): TakeOverStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: TakeOverStep[] = [];
  for (const item of raw) {
    const step = asRecord(item);
    const label = text(step.label, 80);
    const url = pageUrl(step.page);
    const at = url ? { url } : {};
    switch (step.kind) {
      case 'click':
        steps.push({ kind: 'click', role: text(step.role, 24), label, ...at });
        break;
      case 'fill':
        steps.push({
          kind: 'fill',
          label,
          value: text(step.value, 200),
          ...at,
        });
        break;
      case 'secret':
        steps.push({ kind: 'secret', label, ...at });
        break;
      case 'choose':
        steps.push({
          kind: 'choose',
          label,
          value: text(step.value, 80),
          ...at,
        });
        break;
      case 'check':
        steps.push({
          kind: 'check',
          role: text(step.role, 24),
          label,
          checked: step.checked === true,
          ...at,
        });
        break;
      case 'press':
        steps.push({ kind: 'press', label, value: 'Enter', ...at });
        break;
    }
  }
  return steps;
}

/** The steps as plain lines for the model. */
export function describeSteps(steps: TakeOverStep[]): string[] {
  return steps.map((step, index) => {
    const label = step.label ? `"${step.label}"` : 'an unnamed element';
    const line = (() => {
      switch (step.kind) {
        case 'page':
          return `Was on ${step.url}${step.title ? ` ("${step.title}")` : ''}`;
        case 'click':
          return `Clicked the ${step.role || 'element'} ${label}`;
        case 'fill':
          return `Typed "${step.value}" into ${label}`;
        case 'secret':
          return `Typed a sign-in, password or code into ${label} (not recorded)`;
        case 'choose':
          return `Chose "${step.value}" in ${label}`;
        case 'check':
          return `${step.checked ? 'Checked' : 'Unchecked'} ${label}`;
        case 'press':
          return `Pressed Enter in ${label}`;
      }
    })();
    return `${index + 1}. ${line}`;
  });
}

// Origin and path: a query can hold tokens.
function pageUrl(raw: unknown): string {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

async function streamPort(deps: TakeOverDeps): Promise<number> {
  let status = await deps.browser('stream', ['status']);
  if (status.success && asRecord(status.data).enabled !== true) {
    await deps.browser('stream', ['enable']);
    status = await deps.browser('stream', ['status']);
  }
  const port = Number(asRecord(status.data).port);
  if (!status.success || !Number.isInteger(port) || port <= 0) {
    throw new Error(status.error || 'the browser has no stream to share');
  }
  return port;
}

/**
 * Hand the open page to the user and wait until they are done. `sessionId`
 * is the chat's, which the phone names when it connects.
 */
export async function runBrowserTakeOver(
  sessionId: string,
  args: Record<string, unknown>,
  deps: TakeOverDeps,
): Promise<Record<string, unknown>> {
  const reason = text(args.reason, 300);
  const before = asRecord(
    asRecord(
      (
        await deps.browser('eval', [
          '({ url: location.href, title: document.title, width: innerWidth, height: innerHeight, scale: devicePixelRatio })',
        ])
      ).data,
    ).result,
  );
  if (!pageUrl(before.url)) {
    throw new Error(
      'open the page first with browser_navigate, then call browser_take_over',
    );
  }
  const port = await streamPort(deps);
  const opened = asRecord(
    await deps.gateway('/api/browser/take-over', {
      sessionId,
      port,
      reason,
    }),
  );
  const id = text(opened.id, 64);
  if (!id) throw new Error('the gateway did not open the take-over');

  await deps.browser('set', [
    'viewport',
    String(PHONE_VIEWPORT.width),
    String(PHONE_VIEWPORT.height),
    String(PHONE_VIEWPORT.scale),
  ]);
  const steps: TakeOverStep[] = [];
  let lastUrl = '';
  let lastTitle = '';
  let state = 'waiting';
  let remember = false;
  const started = deps.now();
  try {
    while (true) {
      const page = await deps.browser('eval', [TAKE_OVER_RECORDER_SCRIPT]);
      const result = asRecord(asRecord(page.data).result);
      const url = pageUrl(result.url);
      const visit = (at: string) => {
        if (at === lastUrl) return;
        lastUrl = at;
        lastTitle = at === url ? text(result.title) : '';
        steps.push({ kind: 'page', url: at, title: lastTitle });
      };
      // Notes taken just before the page changed belong to the page before.
      for (const step of readRecordedSteps(result.steps)) {
        if (step.url) visit(step.url);
        steps.push(step);
      }
      if (url) visit(url);
      if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);

      const status = asRecord(
        await deps.gateway('/api/browser/take-over/status', { id }),
      );
      state = text(status.state, 16) || 'finished';
      remember = status.remember === true;
      if (state === 'finished') break;
      const elapsed = deps.now() - started;
      if (state === 'waiting' && elapsed > CONNECT_TIMEOUT_MS) break;
      if (elapsed > TAKE_OVER_TIMEOUT_MS) break;
      await deps.sleep(POLL_MS);
    }
  } finally {
    await deps.gateway('/api/browser/take-over/close', { id }).catch(() => {});
    const width = Number(before.width);
    const height = Number(before.height);
    if (width > 0 && height > 0) {
      await deps.browser('set', [
        'viewport',
        String(Math.round(width)),
        String(Math.round(height)),
        String(Number(before.scale) || 1),
      ]);
    }
  }

  const page = { url: lastUrl, title: lastTitle };
  if (state === 'waiting') {
    return {
      taken_over: false,
      ...page,
      next: 'The user did not open the browser. Tell them in one short sentence that the page is waiting for them, and stop.',
    };
  }
  if (state !== 'finished') {
    return {
      taken_over: true,
      timed_out: true,
      ...page,
      next: 'The take-over ran out of time. Look at the page with browser_snapshot before you continue.',
    };
  }
  if (!remember) {
    return {
      taken_over: true,
      ...page,
      next: 'The user is done and handed the browser back. Read the page with browser_snapshot and continue the task from there.',
    };
  }
  return {
    taken_over: true,
    remember: true,
    ...page,
    steps: describeSteps(steps),
    next: "The user showed you how they do this and asked you to remember it. Save it as a mini skill (`skills/<short-name>/SKILL.md` with `mini: true`, see skill-creator): a description with the site and task in the user's words, the start URL, and these steps in your own words, with placeholders for values that change. Never write down a password, code or sign-in; use browser_sign_in for the sign-in step. Then tell the user in one or two short sentences what you saved and ask whether you should run it on a schedule.",
  };
}
