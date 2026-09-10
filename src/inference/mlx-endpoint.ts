/**
 * MLX endpoint boundary: managed inference stays on this machine.
 * Unlike general compatible providers, MLX never follows remote endpoint URLs.
 * This validates the transport destination, not the contents of a prompt.
 */
export function assertMlxEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1'
  ) {
    throw new Error('MLX requires http://127.0.0.1:<port>/v1 on this Mac.');
  }
  return url;
}
