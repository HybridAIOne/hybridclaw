#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'serve':
    await import('./index.js');
    break;
  case 'gateway':
    await import('./gateway.js');
    break;
  case 'tui':
    await import('./tui.js');
    break;
  default:
    console.log(`Usage: hybridclaw <command>

Commands:
  gateway Start core runtime (web/API/scheduler/heartbeat)
  serve   Start Discord adapter (requires running gateway)
  tui     Start terminal adapter (requires running gateway)`);
    process.exit(command ? 1 : 0);
}
