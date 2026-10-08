/**
 * Load-once holder for a module kept out of the gateway startup graph.
 *
 * Concurrent load() calls share one in-flight load; a success is cached for
 * the process, and a failure is not, so the next load() calls the importer
 * again. A retry re-evaluates the module only if the importer can: a failed
 * `import()` of a CommonJS package stays cached by Node's ESM loader, so an
 * importer that must recover in-process (a native addon rebuilt while the
 * gateway runs) loads it with `createRequire` instead.
 */

export interface LazyModule<T> {
  load(): Promise<T>;
  current(): T | null;
  // Joins a load already in flight; never starts one.
  loadIfRequested(): Promise<T | null>;
}

export function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    load: () => {
      pending ??= importer().then(
        (module) => {
          loaded = module;
          return module;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    current: () => loaded,
    loadIfRequested: async () => (pending ? await pending : null),
  };
}
