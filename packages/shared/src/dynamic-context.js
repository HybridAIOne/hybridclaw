export const DYNAMIC_CONTEXT_MESSAGE_PREFIX = '<context>\nDate (UTC): ';

export function isDynamicContextMessageText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trimStart();
  return (
    text.startsWith(DYNAMIC_CONTEXT_MESSAGE_PREFIX) &&
    text.includes('\n</context>')
  );
}
