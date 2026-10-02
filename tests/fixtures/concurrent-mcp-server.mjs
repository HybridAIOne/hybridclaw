// Records real stdio MCP call overlap and completion, independently of runtime logs.
import fs from 'node:fs';
import readline from 'node:readline';

const logPath = process.argv[2];
let active = 0;
const tools = [
  { name: 'lookup', annotations: { readOnlyHint: true } },
  { name: 'mutate', annotations: { readOnlyHint: false } },
  { name: 'execute_action' },
].map((tool) => ({ ...tool, inputSchema: { type: 'object' } }));

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'concurrent', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = { tools };
  } else {
    const { name, arguments: args } = message.params;
    active += 1;
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ event: 'start', name, id: args.id, active })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, args.delay ?? 30));
    active -= 1;
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ event: 'end', name, id: args.id, active })}\n`,
    );
    result = {
      content: [{ type: 'text', text: String(args.id) }],
      ...(args.fail ? { isError: true } : {}),
    };
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
  );
});
