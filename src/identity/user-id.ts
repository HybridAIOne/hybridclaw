export const USER_ID_DEFAULT_AUTHORITY = 'hybridai';
export const USER_ID_LOCAL_AUTHORITY = 'local';
export const RESERVED_USER_AUTHORITIES = [
  USER_ID_DEFAULT_AUTHORITY,
  USER_ID_LOCAL_AUTHORITY,
] as const;

export type ReservedUserAuthority = (typeof RESERVED_USER_AUTHORITIES)[number];

/**
 * Parsed canonical user ID. `id` is always `${username}@${authority}`.
 */
export interface ParsedUserId {
  readonly id: string;
  readonly username: string;
  readonly authority: string;
}

export class UserIdValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid user id: ${issues.join('; ')}`);
    this.name = 'UserIdValidationError';
    this.issues = [...issues];
  }
}

const USER_ID_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function normalizeUserIdComponent(value: string): string {
  return value.trim().toLowerCase();
}

function validateUserIdComponent(
  label: 'username' | 'authority',
  value: string,
  issues: string[],
): void {
  if (!value) {
    issues.push(`${label} is required`);
    return;
  }
  if (!USER_ID_COMPONENT_PATTERN.test(value)) {
    issues.push(
      `${label} must start with a letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens`,
    );
  }
}

function normalizeAndValidateUserIdParts(
  username: string,
  authority: string,
): ParsedUserId {
  const normalizedUsername = normalizeUserIdComponent(username);
  const normalizedAuthority = normalizeUserIdComponent(authority);
  const issues: string[] = [];

  validateUserIdComponent('username', normalizedUsername, issues);
  validateUserIdComponent('authority', normalizedAuthority, issues);

  if (issues.length > 0) {
    throw new UserIdValidationError(issues);
  }

  return {
    id: `${normalizedUsername}@${normalizedAuthority}`,
    username: normalizedUsername,
    authority: normalizedAuthority,
  };
}

export function formatUserId(
  username: string,
  authority = USER_ID_DEFAULT_AUTHORITY,
): string {
  return normalizeAndValidateUserIdParts(username, authority).id;
}

export function parseUserId(value: string): ParsedUserId {
  const normalized = value.trim();

  if (!normalized) {
    throw new UserIdValidationError(['user id is required']);
  }

  const parts = normalized.split('@');
  if (parts.length !== 2) {
    throw new UserIdValidationError([
      'user id must use the username@authority format',
    ]);
  }

  const [username = '', authority = ''] = parts;
  return normalizeAndValidateUserIdParts(username, authority);
}

function normalizeComparableUserId(value: string | ParsedUserId): string {
  if (typeof value === 'string') {
    return parseUserId(value).id;
  }
  return value.id;
}

export function compareUserIds(
  left: string | ParsedUserId,
  right: string | ParsedUserId,
): number {
  const normalizedLeft = normalizeComparableUserId(left);
  const normalizedRight = normalizeComparableUserId(right);
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function userIdsEqual(
  left: string | ParsedUserId,
  right: string | ParsedUserId,
): boolean {
  return compareUserIds(left, right) === 0;
}

export function isReservedUserAuthority(
  authority: string,
): authority is ReservedUserAuthority {
  const normalized = normalizeUserIdComponent(authority);
  return RESERVED_USER_AUTHORITIES.includes(
    normalized as ReservedUserAuthority,
  );
}
