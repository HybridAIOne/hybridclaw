#!/usr/bin/env node
/**
 * Notebook helper uses only the worker's configured gateway and agent identity.
 * It sends revision-bearing operations unchanged and never retries a write.
 * Unlike external-service wrappers, it needs no account secrets or approvals.
 */
const fs = require('node:fs');
const commands = new Set(['list', 'read', 'apply']);
const operations = new Set(['create', 'scratchpad', 'rename', 'move', 'archive', 'unarchive', 'save']);
function request(args, env, input) {
  const [command, id, revision] = args;
  if (!commands.has(command)) throw new Error('Usage: notes.cjs list | read <id> [revision] | apply < operation.json');
  const base = env.HYBRIDCLAW_GATEWAY_URL;
  const token = env.HYBRIDCLAW_GATEWAY_TOKEN;
  const agent = env.HYBRIDCLAW_AGENT_ID;
  if (!base || !token || !agent) throw new Error('Notebook access needs the configured worker gateway and agent identity.');
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Invalid gateway origin.');
  const url = new URL('/api/notes/runtime', origin);
  url.searchParams.set('agentId', agent);
  let body;
  if (command === 'list') body = { operation: 'list' };
  else if (command === 'read') {
    if (!id) throw new Error('Expected a page ID.');
    body = { operation: 'read', id, ...(revision ? { revision } : {}) };
  } else {
    body = JSON.parse(input);
    if (!body || Array.isArray(body) || typeof body !== 'object' || !operations.has(body.operation)) throw new Error('Expected a notebook write operation.');
  }
  return { url: url.toString(), body, token, agent };
}
async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--request');
  const clean = args.filter(arg => arg !== '--request');
  const built = request(clean, process.env, clean[0] === 'apply' ? fs.readFileSync(0, 'utf8') : '');
  if (dry) { process.stdout.write(JSON.stringify({ url: built.url, method: 'POST', body: built.body }) + '\n'); return; }
  const response = await fetch(built.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${built.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(built.body) });
  if (!response.ok) throw new Error(response.status === 409 ? '409: Notebook changed. Read the latest version and reconcile your changes.' : `Notebook request failed (${response.status}).`);
  const answer = await response.json();
  if (answer.scope !== 'agent-notes' || answer.agentId !== built.agent) throw new Error('Notebook answered for a different workspace.');
  const link = id => `hybridclaw://notes/${encodeURIComponent(id)}?agentId=${encodeURIComponent(built.agent)}`;
  if (answer.page) answer.link = link(answer.page.id);
  if (Array.isArray(answer.pages)) answer.pages = answer.pages.map(page => ({ ...page, link: link(page.id) }));
  process.stdout.write(JSON.stringify(answer) + '\n');
}
module.exports = { request };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
