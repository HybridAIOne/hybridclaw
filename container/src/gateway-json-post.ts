/**
 * JSON POST to the gateway for calls that may legitimately run for many
 * minutes (plugin tools such as video generation). Global `fetch` aborts when
 * response headers take longer than 300s; this client waits up to `timeoutMs`
 * of socket inactivity instead.
 *
 * NOT a general HTTP client: no redirects, no retries, gateway URLs only.
 */
import http from 'node:http';
import https from 'node:https';

export interface GatewayJsonResponse {
  ok: boolean;
  status: number;
  text: string;
}

export function postGatewayJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<GatewayJsonResponse> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(`gateway request timed out after ${timeoutMs}ms`),
      );
    });
    request.on('error', reject);
    request.end(payload);
  });
}
