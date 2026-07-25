/**
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function prepareLineTextChunks(text, limit) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];
  const chunkLimit = Math.max(200, Math.min(5_000, Math.trunc(limit)));
  const chunks = [];
  let remaining = normalized;

  while (remaining.length > chunkLimit) {
    const candidate = remaining.slice(0, chunkLimit);
    const splitAt = Math.max(
      candidate.lastIndexOf('\n'),
      candidate.lastIndexOf(' '),
    );
    const end = splitAt >= Math.floor(chunkLimit * 0.6) ? splitAt : chunkLimit;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * @param {{
 *   client: import('@jsr/evex__linejs').Client;
 *   to: string;
 *   text: string;
 *   limit: number;
 * }} params
 */
export async function sendChunkedLineText(params) {
  for (const chunk of prepareLineTextChunks(params.text, params.limit)) {
    await params.client.base.talk.sendMessage({
      to: params.to,
      text: chunk,
      e2ee: true,
    });
  }
}
