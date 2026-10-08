/**
 * The agent container's name for the host: loopback URLs handed to the
 * container are rewritten to `host.docker.internal`, and the docker args here
 * make that name resolve. Docker Desktop defines it; a native Linux daemon
 * does not, so there it is mapped to the bridge gateway (`host-gateway`).
 *
 * The mapping only names an address the container can already route to; it
 * grants no reachability, and host services bound to 127.0.0.1 stay out of
 * reach. NOT an egress control: `container.network` decides that.
 */

export function remapHostBaseUrlForContainer(baseUrl: string): string {
  return baseUrl.replace(
    /\/\/(localhost|127\.0\.0\.1)([:/])/,
    '//host.docker.internal$2',
  );
}

// Every container gets the mapping, not only those whose current URLs were
// rewritten: a pooled container is reused across turns that switch models.
export function containerHostAliasArgs(
  platform: NodeJS.Platform,
  network: string,
): string[] {
  if (platform !== 'linux') return [];
  // `none` has no route to name; `container:<id>` rejects --add-host.
  if (network === 'none' || network.startsWith('container:')) return [];
  return ['--add-host=host.docker.internal:host-gateway'];
}
