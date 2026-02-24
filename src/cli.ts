#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'serve':
    await import('./index.js');
    break;
  case 'tui':
    await import('./tui.js');
    break;
  default:
    console.log(`Usage: hybridclaw <command>

Commands:
  serve   Start the Discord bot
  tui     Start the terminal UI`);
    process.exit(command ? 1 : 0);
}
