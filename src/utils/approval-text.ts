export function isApprovalHistoryMessage(content: string): boolean {
  const text = String(content || '').trim();
  if (!text) return false;
  if (!text.includes('Approval ID:')) return false;

  return (
    text.startsWith('Approval needed for:') ||
    text.startsWith('I need your approval before I ') ||
    text.startsWith('**Pending Approval**') ||
    text.includes('Reply `yes` to approve once.') ||
    text.includes('Approval expires in')
  );
}
