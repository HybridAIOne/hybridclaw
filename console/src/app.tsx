import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuth } from './auth';
import { LoginScreen } from './components/login-screen';
import { createQueryClient } from './queries';
import { router } from './router';

export function App() {
  const auth = useAuth();
  const [queryClient] = useState(() => createQueryClient());

  if (auth.status === 'checking') {
    return (
      <div className="login-shell">
        <div className="login-card">
          <p className="eyebrow">HybridClaw Admin</p>
          <h1>Connecting.</h1>
          <p className="supporting-text">
            Checking whether this instance is localhost-only or protected by
            <code> WEB_API_TOKEN</code>.
          </p>
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
          <button className="primary-button" type="button" onClick={auth.retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (auth.status === 'prompt') {
    return <LoginScreen />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router}
        context={{
          queryClient,
          token: auth.token,
          gatewayStatus: auth.gatewayStatus,
        }}
      />
    </QueryClientProvider>
  );
}
