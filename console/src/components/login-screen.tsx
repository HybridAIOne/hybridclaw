import { type FormEvent, useState } from 'react';
import { useAuth } from '../auth';

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
        <h1>Enter API token.</h1>
        <p className="supporting-text">
          This instance has <code>WEB_API_TOKEN</code> enabled. Enter it once
          and the console will keep it in local storage, the same way
          <code> /chat</code> already does.
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
              placeholder="Paste WEB_API_TOKEN"
            />
          </label>
          {auth.error ? <p className="error-banner">{auth.error}</p> : null}
          <button className="primary-button" type="submit">
            {auth.status === 'checking' ? 'Checking...' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
