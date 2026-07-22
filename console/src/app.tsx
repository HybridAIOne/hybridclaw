import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { Button } from './components/button';
import { HybridClaw } from './components/icons';
import { LoginScreen } from './components/login-screen';
import { resolveBrowserTitle } from './lib/browser-title';
import { router } from './router';

export function App() {
  const auth = useAuth();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    document.title = resolveBrowserTitle(window.location.pathname);
  }, []);

  if (auth.status === 'checking') {
    return (
      <div className="loading-shell">
        <div
          aria-label="Loading HybridClaw"
          aria-live="polite"
          className="loading-panel"
          role="status"
        >
          <div className="loading-mark-wrap">
            <HybridClaw className="loading-mark" />
          </div>
          <div className="loading-copy">
            <h1>Loading HybridClaw ...</h1>
          </div>
          <div className="loading-progress" aria-hidden="true">
            <span />
          </div>
        </div>
      </div>
    );
  }

  if (auth.status === 'error') {
    return (
      <div className="login-shell">
        <div className="login-card">
          <p className="eyebrow">HybridClaw Admin</p>
          <h1>Console unavailable.</h1>
          <p className="supporting-text">{auth.error}</p>
          <Button onClick={auth.retry}>Retry</Button>
        </div>
      </div>
    );
  }

  if (auth.status === 'prompt') {
    return <LoginScreen />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
