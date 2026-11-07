// Records real stdio MCP overlap; arrival barriers avoid assuming dispatch latency.
import fs from 'node:fs';
import readline from 'node:readline';

const logPath = process.argv[2];
let active = 0;
const started = new Set();
const waiting = new Set();
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
    if (args.startDelay) {
      await new Promise((resolve) => setTimeout(resolve, args.startDelay));
    }
    active += 1;
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ event: 'start', name, id: args.id, active })}\n`,
    );
    started.add(args.id);
    for (const ready of waiting) ready();
    if (args.waitFor) {
      await new Promise((resolve) => {
        const ready = () => {
          if (args.waitFor.every((id) => started.has(id))) {
            waiting.delete(ready);
            resolve();
          }
        };
        waiting.add(ready);
        ready();
      });
    }
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
