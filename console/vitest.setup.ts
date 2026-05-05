// jsdom does not implement ResizeObserver or Element.scrollIntoView.
// Components such as ScrollArea instantiate the former on mount, and
// listbox-style components call the latter to keep the active option in
// view, so tests that render those components crash without these shims.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}

if (
  typeof Element !== 'undefined' &&
  typeof Element.prototype.scrollIntoView !== 'function'
) {
  Element.prototype.scrollIntoView = () => {};
}
