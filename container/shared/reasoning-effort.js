export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

export function isReasoningEffort(value) {
  return REASONING_EFFORTS.includes(value);
}
