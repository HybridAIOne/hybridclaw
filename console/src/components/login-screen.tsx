import { type FormEvent, useState } from 'react';
import { useAuth } from '../auth';
import { Button } from './button';

export function LoginScreen() {
  const auth = useAuth();
  const [token, setToken] = useState(auth.token);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await auth.login(token);
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <p className="eyebrow">HybridClaw Admin</p>
        <h1>Enter the gateway web token.</h1>
        <p className="supporting-text">
          This fallback is for self-hosted gateways. Enter the exact{' '}
          <code>WEB_API_TOKEN</code> configured for this gateway, not a HybridAI
          API key or scoped admin token. The console uses it only until this
          page is reloaded.
        </p>
        <form className="stack-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Token</span>
            <input
              autoComplete="off"
              spellCheck={false}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste this gateway's WEB_API_TOKEN"
            />
          </label>
          {auth.error ? <p className="error-banner">{auth.error}</p> : null}
          <Button type="submit">
            {auth.status === 'checking' ? 'Checking...' : 'Continue'}
          </Button>
        </form>
      </div>
    </div>
  );
}
