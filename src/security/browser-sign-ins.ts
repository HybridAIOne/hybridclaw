/**
 * Website sign-ins the user saved for the agent's browser: a password, and
 * usually a username, per site. They live in the encrypted runtime store, and
 * the gateway types them into the page (`browser_sign_in`, which injects
 * through `/api/secret/inject`), so the model never sees them.
 *
 * Each value is bound to the exact host it was saved for, with the store's
 * `<NAME>_BOUND_DOMAIN` convention (the HTTP proxy binds captured bearer
 * tokens the same way). A `SIGNIN_*` secret resolves only for its own host,
 * and one without a binding never resolves, whatever the workspace secret
 * policy allows: `browserSignInHostProblem` is checked before that policy.
 *
 * NOT the HTTP auth routes (`secret route add`), which inject API credentials
 * into `http_request` calls.
 */
import { createHash } from 'node:crypto';

import {
  listRuntimeSecretMetadata,
  readStoredRuntimeSecret,
  saveNamedRuntimeSecrets,
} from './runtime-secrets.js';

export const BROWSER_SIGN_IN_SECRET_PREFIX = 'SIGNIN_';
const USERNAME_SUFFIX = '_USERNAME';
const PASSWORD_SUFFIX = '_PASSWORD';
const BOUND_DOMAIN_SUFFIX = '_BOUND_DOMAIN';
// Secret names stop at 128 characters, and the longest one built from a host
// is the password's binding.
const MAX_HOST_SLUG_LENGTH =
  128 -
  BROWSER_SIGN_IN_SECRET_PREFIX.length -
  PASSWORD_SUFFIX.length -
  BOUND_DOMAIN_SUFFIX.length;
const HOST_LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOSTNAME_RE = new RegExp(
  `^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL})*$`,
);

export interface BrowserSignIn {
  host: string;
  /** Absent when only a password was saved. */
  usernameSecret?: string;
  passwordSecret: string;
}

export interface BrowserSignInSummary {
  host: string;
  username: boolean;
  savedAt: string | null;
}

/** A page's hostname as sign-ins are keyed, or '' when it is not one. */
export function normalizeBrowserSignInHost(raw: unknown): string {
  const host = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return HOSTNAME_RE.test(host) ? host : '';
}

function hostSlug(host: string): string {
  const slug = host.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (slug.length <= MAX_HOST_SLUG_LENGTH) return slug;
  const digest = createHash('sha256')
    .update(host)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `${slug.slice(0, MAX_HOST_SLUG_LENGTH - digest.length - 1)}_${digest}`;
}

/**
 * The store names for a host's sign-in. Two hosts can share a slug
 * (`a-b.com`, `a.b.com`); the binding tells them apart, so the later save
 * replaces the earlier one instead of lending it to the other site.
 */
export function browserSignInSecretNames(host: string): {
  username: string;
  password: string;
} {
  const base = `${BROWSER_SIGN_IN_SECRET_PREFIX}${hostSlug(host)}`;
  return {
    username: `${base}${USERNAME_SUFFIX}`,
    password: `${base}${PASSWORD_SUFFIX}`,
  };
}

export function isBrowserSignInSecretName(name: string): boolean {
  return name.startsWith(BROWSER_SIGN_IN_SECRET_PREFIX);
}

function boundDomainSecretName(secretName: string): string {
  return `${secretName}${BOUND_DOMAIN_SUFFIX}`;
}

function readBoundHost(secretName: string): string {
  return normalizeBrowserSignInHost(
    readStoredRuntimeSecret(boundDomainSecretName(secretName)),
  );
}

/**
 * Why a stored secret may not be resolved for `host`, or '' when it may.
 * Only sign-in secrets are checked; every other secret is left to the
 * workspace secret policy.
 */
export function browserSignInHostProblem(
  secretName: string,
  host: string | undefined,
): string {
  if (!isBrowserSignInSecretName(secretName)) return '';
  const bound = readBoundHost(secretName);
  if (!bound) return `Sign-in ${secretName} is not bound to a site.`;
  const target = normalizeBrowserSignInHost(host);
  if (target === bound) return '';
  return `Sign-in ${secretName} is only for ${bound}, not ${target || 'a request without a site'}.`;
}

/** The sign-in saved for exactly this host, if there is one. */
export function findBrowserSignIn(rawHost: unknown): BrowserSignIn | null {
  const host = normalizeBrowserSignInHost(rawHost);
  if (!host) return null;
  const names = browserSignInSecretNames(host);
  if (!readStoredRuntimeSecret(names.password)) return null;
  if (readBoundHost(names.password) !== host) return null;
  const username =
    readStoredRuntimeSecret(names.username) &&
    readBoundHost(names.username) === host;
  return {
    host,
    ...(username ? { usernameSecret: names.username } : {}),
    passwordSecret: names.password,
  };
}

/**
 * Save a site's sign-in with its bindings in one store write. Throws on an
 * invalid host or password; the message never contains a value.
 */
export function saveBrowserSignIn(params: {
  host: unknown;
  username?: unknown;
  password: unknown;
}): BrowserSignIn {
  const host = normalizeBrowserSignInHost(params.host);
  if (!host) throw new Error('Expected the site as a hostname.');
  const password = typeof params.password === 'string' ? params.password : '';
  if (!password.trim()) throw new Error('Expected a password.');
  // The store trims every value, so such a password would be saved wrong.
  if (password !== password.trim()) {
    throw new Error(
      'A password that starts or ends with a space cannot be saved.',
    );
  }
  const username =
    typeof params.username === 'string' ? params.username.trim() : '';
  const names = browserSignInSecretNames(host);
  saveNamedRuntimeSecrets({
    [names.password]: password,
    [boundDomainSecretName(names.password)]: host,
    [names.username]: username || null,
    [boundDomainSecretName(names.username)]: username ? host : null,
  });
  return {
    host,
    ...(username ? { usernameSecret: names.username } : {}),
    passwordSecret: names.password,
  };
}

/** Forget a site's sign-in; false when none was saved for it. */
export function deleteBrowserSignIn(rawHost: unknown): boolean {
  const host = normalizeBrowserSignInHost(rawHost);
  if (!host || !findBrowserSignIn(host)) return false;
  const names = browserSignInSecretNames(host);
  saveNamedRuntimeSecrets({
    [names.password]: null,
    [boundDomainSecretName(names.password)]: null,
    [names.username]: null,
    [boundDomainSecretName(names.username)]: null,
  });
  return true;
}

/** Saved sites without their usernames or passwords. */
export function listBrowserSignIns(): BrowserSignInSummary[] {
  const signIns: BrowserSignInSummary[] = [];
  for (const entry of listRuntimeSecretMetadata()) {
    if (
      entry.state !== 'set' ||
      !isBrowserSignInSecretName(entry.name) ||
      !entry.name.endsWith(PASSWORD_SUFFIX)
    ) {
      continue;
    }
    const host = readBoundHost(entry.name);
    const signIn = host ? findBrowserSignIn(host) : null;
    if (signIn?.passwordSecret !== entry.name) continue;
    signIns.push({
      host,
      username: Boolean(signIn.usernameSecret),
      savedAt: entry.last_rotated_at,
    });
  }
  return signIns.sort((left, right) => left.host.localeCompare(right.host));
}
