export function resolveBrowserTitle(pathname: string): string {
  if (pathname === '/chat/ideas') {
    return 'HybridClaw Ideas';
  }

  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    return 'HybridClaw Chat';
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
