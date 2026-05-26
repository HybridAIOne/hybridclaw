export function getHiddenInput(
  container: HTMLElement,
): HTMLInputElement | null {
  return container.querySelector('input[type="hidden"]');
}
