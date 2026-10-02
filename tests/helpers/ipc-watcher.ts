import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { vi } from 'vitest';

class TestIpcWatcher extends EventEmitter {
  closed = false;
  close = vi.fn(() => {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  });
}

export function mockIpcWatcher() {
  const watchers: TestIpcWatcher[] = [];
  const watch = vi
    .spyOn(fs, 'watch')
    .mockImplementation((_path, _options, listener) => {
      const watcher = new TestIpcWatcher();
      if (listener) watcher.on('change', listener);
      watchers.push(watcher);
      return watcher as unknown as fs.FSWatcher;
    });
  return {
    watch,
    watchers,
    notify() {
      for (const watcher of watchers) {
        if (!watcher.closed) watcher.emit('change', 'rename', null);
      }
    },
  };
}
