/**
 * Browser titles share one unread count across route and chat updates.
 * This is display state only; the gateway owns durable unread notifications.
 */
let chatUnreadCount = 0;

export function updateBrowserTitle(pathname: string): void {
  document.title = resolveBrowserTitle(pathname, chatUnreadCount);
}

export function setChatUnreadCount(count: number): void {
  chatUnreadCount = count;
  updateBrowserTitle(window.location.pathname);
}

export function resolveBrowserTitle(pathname: string, unreadCount = 0): string {
  const unreadPrefix = unreadCount > 0 ? `(${unreadCount}) ` : '';
  if (pathname === '/chat/ideas') {
    return `${unreadPrefix}HybridClaw Ideas`;
  }

  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    return `${unreadPrefix}HybridClaw Chat`;
  }

  if (pathname === '/apps' || pathname.startsWith('/apps/')) {
    return 'HybridClaw Apps';
  }

  if (pathname === '/agents' || pathname.startsWith('/agents/')) {
    return 'HybridClaw Agents';
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return 'HybridClaw Admin';
  }

  return 'HybridClaw';
}
