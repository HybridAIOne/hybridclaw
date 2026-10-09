// Stands in for the HybridAI platform's premium image tool: an unanswered
// call returns a boost offer, an answered one the boosted or standard image.
// Every call's params are appended to the log file given as the first argument.
import fs from 'node:fs';
import readline from 'node:readline';

const logPath = process.argv[2];
const OFFER_ID = '0123456789abcdef0123456789abcdef';

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'hybridai', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = {
      tools: [{ name: 'image_generate', inputSchema: { type: 'object' } }],
    };
  } else {
    fs.appendFileSync(logPath, `${JSON.stringify(message.params)}\n`);
    const answer = message.params._meta?.['hybridai/boost'];
    result = answer
      ? {
          content: [
            {
              type: 'text',
              text: answer.use ? 'Flux image ready' : 'Standard image ready',
            },
          ],
        }
      : {
          content: [
            {
              type: 'text',
              text: 'Waiting for the user to choose whether to use a boost.',
            },
          ],
          _meta: {
            'hybridai/boostOffer': {
              id: OFFER_ID,
              category: 'image',
              modelName: 'Flux 2 Pro',
              available: 3,
            },
          },
        };
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
  );
});
