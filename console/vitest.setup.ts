// jsdom does not implement ResizeObserver. Components such as ScrollArea
// instantiate one on mount, so tests that render those components crash
// without a polyfill. Provide a no-op shim that tests can rely on.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}
