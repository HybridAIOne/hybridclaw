// Stdio MCP server with one tool, `ping`. Appends each message's method to the
// file named by its first argument, so a test can see when a client connected
// and whether it connected twice.
import fs from 'node:fs';

const logPath = process.argv[2];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    fs.appendFileSync(logPath, `${message.method}\n`);
    if (message.id === undefined) continue;
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'logging', version: '1.0.0' },
          }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'pong' }] };
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
    );
  }
});
process.stdin.on('end', () => process.exit(0));
