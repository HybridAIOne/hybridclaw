/**
 * Plugin admin-route table — each `(method, path)` under `/api/admin/<pluginId>`
 * has exactly one owner and one RBAC action from the core catalog.
 *
 * Registration fails loudly on an unknown method or action, a path outside
 * the plugin's namespace, a path core already maps, or one that overlaps a
 * registered route, so a
 * plugin can never shadow a core route or ship an unchecked one. Lookups
 * never fall through to another route. NOT the authenticator: the gateway
 * authenticates and enforces `rbacAction` before a handler runs.
 */
import {
  ADMIN_RBAC_ACTIONS,
  resolveAdminRbacAction,
} from '../security/admin-rbac.js';
import type { PluginAdminRouteDefinition } from './plugin-types.js';

const ADMIN_ROUTE_METHODS = new Set(['GET', 'POST', 'DELETE']);
const ADMIN_RBAC_ACTION_SET: ReadonlySet<string> = new Set(ADMIN_RBAC_ACTIONS);
const PATH_SEGMENT_RE = /^(:[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9._-]+)$/;

export interface RegisteredPluginAdminRoute {
  pluginId: string;
  route: PluginAdminRouteDefinition;
  segments: string[];
}

export type PluginAdminRouteMatch =
  | {
      kind: 'route';
      entry: RegisteredPluginAdminRoute;
      params: Record<string, string>;
    }
  | { kind: 'method-not-allowed' }
  | { kind: 'bad-path' };

function splitPath(pathname: string): string[] {
  return pathname.split('/').slice(1);
}

function validateAdminRoute(
  pluginId: string,
  route: PluginAdminRouteDefinition,
): string[] {
  const label = `Plugin "${pluginId}" admin route ${String(route.method)} ${String(route.path)}`;
  if (!ADMIN_ROUTE_METHODS.has(route.method)) {
    throw new Error(`${label} has an unsupported method.`);
  }
  if (!ADMIN_RBAC_ACTION_SET.has(route.rbacAction)) {
    throw new Error(
      `${label} has unknown rbacAction "${String(route.rbacAction)}".`,
    );
  }
  if (typeof route.handler !== 'function') {
    throw new Error(`${label} is missing a handler.`);
  }
  const namespace = `/api/admin/${pluginId}`;
  const path = String(route.path || '');
  if (path !== namespace && !path.startsWith(`${namespace}/`)) {
    throw new Error(`${label} must live under ${namespace}.`);
  }
  const segments = splitPath(path);
  if (!segments.every((segment) => PATH_SEGMENT_RE.test(segment))) {
    throw new Error(`${label} has an invalid path segment.`);
  }
  if (resolveAdminRbacAction(path, route.method)) {
    throw new Error(`${label} is already a core admin route.`);
  }
  return segments;
}

function patternsOverlap(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment === right[index] ||
        segment.startsWith(':') ||
        right[index].startsWith(':'),
    )
  );
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const segment = actual[index];
    if (expected.startsWith(':')) {
      if (!segment) return null;
      params[expected.slice(1)] = segment;
    } else if (expected !== segment) {
      return null;
    }
  }
  return params;
}

export class PluginAdminRouteRegistry {
  private entries: RegisteredPluginAdminRoute[] = [];

  register(pluginId: string, route: PluginAdminRouteDefinition): void {
    const segments = validateAdminRoute(pluginId, route);
    const clash = this.entries.find(
      (entry) =>
        entry.route.method === route.method &&
        patternsOverlap(entry.segments, segments),
    );
    if (clash) {
      throw new Error(
        `Plugin admin route ${route.method} ${route.path} overlaps ${clash.route.path}, already registered.`,
      );
    }
    this.entries.push({ pluginId, route: { ...route }, segments });
  }

  /** Returns null when no registered route has this path. */
  match(method: string, pathname: string): PluginAdminRouteMatch | null {
    const actual = splitPath(pathname);
    let pathMatched = false;
    for (const entry of this.entries) {
      const params = matchSegments(entry.segments, actual);
      if (!params) continue;
      pathMatched = true;
      if (entry.route.method !== method.toUpperCase()) continue;
      try {
        for (const key of Object.keys(params)) {
          params[key] = decodeURIComponent(params[key]);
        }
      } catch {
        return { kind: 'bad-path' };
      }
      return { kind: 'route', entry, params };
    }
    return pathMatched ? { kind: 'method-not-allowed' } : null;
  }

  snapshot(): RegisteredPluginAdminRoute[] {
    return [...this.entries];
  }

  restore(entries: RegisteredPluginAdminRoute[]): void {
    this.entries = [...entries];
  }
}
