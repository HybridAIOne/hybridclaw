// jsdom does not implement the Web Animations API.
// Stub getAnimations so hooks that use el.getAnimations() degrade gracefully.
if (!HTMLElement.prototype.getAnimations) {
  HTMLElement.prototype.getAnimations = () => [];
}
