// Stdio MCP server that is slow to stop, holding an agent's MCP teardown open.
// It serves no tools, ignores SIGTERM, and exits 1.5s after its stdin closes;
// with `--hold` it never exits on its own, so the MCP SDK kills it after 4s.
const hold = process.argv.includes('--hold');
const parentPid = process.ppid;
process.on('SIGTERM', () => {});
// Keeps the server alive, but never past the agent that spawned it.
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(0);
}, 200);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'slow-exit', version: '1.0.0' },
          }
        : { tools: [] };
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
    );
  }
});
process.stdin.on('end', () => {
  if (!hold) setTimeout(() => process.exit(0), 1_500);
});
