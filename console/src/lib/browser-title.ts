export function resolveBrowserTitle(pathname: string): string {
  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    return 'HybridClaw Chat';
  }

  if (pathname === '/agents' || pathname.startsWith('/agents/')) {
    return 'HybridClaw Agents';
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return 'HybridClaw Admin';
  }

  return 'HybridClaw';
}
