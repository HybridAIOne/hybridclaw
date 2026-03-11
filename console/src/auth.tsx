import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  AUTH_REQUIRED_EVENT,
  clearStoredToken,
  fetchHealth,
  readStoredToken,
  storeToken,
  validateToken,
} from './api/client';
import type { GatewayStatus } from './api/types';

type AuthState =
  | {
      status: 'checking';
      token: string;
      gatewayStatus: null;
      error: string | null;
    }
  | {
      status: 'ready';
      token: string;
      gatewayStatus: GatewayStatus;
      error: null;
    }
  | {
      status: 'prompt';
      token: string;
      gatewayStatus: null;
      error: string | null;
    }
  | {
      status: 'error';
      token: string;
      gatewayStatus: GatewayStatus | null;
      error: string;
    };

type AuthContextValue = AuthState & {
  login: (token: string) => Promise<void>;
  logout: () => void;
  retry: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider(props: { children: ReactNode }) {
  const [initialToken] = useState(() => readStoredToken());
  const [state, setState] = useState<AuthState>({
    status: 'checking',
    token: initialToken,
    gatewayStatus: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async (): Promise<void> => {
      try {
        const health = await fetchHealth();
        if (cancelled) return;

        if (health.webAuthConfigured) {
          if (!initialToken.trim()) {
            setState({
              status: 'prompt',
              token: '',
              gatewayStatus: null,
              error: null,
            });
            return;
          }

          try {
            const gatewayStatus = await validateToken(initialToken);
            if (cancelled) return;
            setState({
              status: 'ready',
              token: initialToken,
              gatewayStatus,
              error: null,
            });
            return;
          } catch (error) {
            if (cancelled) return;
            clearStoredToken();
            setState({
              status: 'prompt',
              token: '',
              gatewayStatus: null,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }

        try {
          const gatewayStatus = await validateToken(initialToken);
          if (cancelled) return;
          setState({
            status: 'ready',
            token: initialToken,
            gatewayStatus,
            error: null,
          });
        } catch {
          if (cancelled) return;
          clearStoredToken();
          setState({
            status: 'error',
            token: '',
            gatewayStatus: health,
            error:
              'This admin console is localhost-only unless WEB_API_TOKEN is configured.',
          });
        }
      } catch (error) {
        if (cancelled) return;
        setState({
          status: 'error',
          token: '',
          gatewayStatus: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [initialToken]);

  useEffect(() => {
    const onAuthRequired = (event: Event): void => {
      const detail =
        event instanceof CustomEvent &&
        event.detail &&
        typeof event.detail === 'object'
          ? (event.detail as { message?: unknown })
          : null;
      setState({
        status: 'prompt',
        token: '',
        gatewayStatus: null,
        error:
          typeof detail?.message === 'string'
            ? detail.message
            : 'API token required.',
      });
    };

    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    };
  }, []);

  const value: AuthContextValue = {
    ...state,
    async login(token: string) {
      const trimmed = token.trim();
      if (!trimmed) {
        setState({
          status: 'prompt',
          token: '',
          gatewayStatus: null,
          error: 'Enter a WEB_API_TOKEN to continue.',
        });
        return;
      }

      setState({
        status: 'checking',
        token: trimmed,
        gatewayStatus: null,
        error: null,
      });

      try {
        const gatewayStatus = await validateToken(trimmed);
        storeToken(trimmed);
        setState({
          status: 'ready',
          token: trimmed,
          gatewayStatus,
          error: null,
        });
      } catch (error) {
        clearStoredToken();
        setState({
          status: 'prompt',
          token: '',
          gatewayStatus: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    logout() {
      clearStoredToken();
      if (state.gatewayStatus?.webAuthConfigured) {
        setState({
          status: 'prompt',
          token: '',
          gatewayStatus: null,
          error: null,
        });
        return;
      }
      if (state.gatewayStatus) {
        setState({
          status: 'ready',
          token: '',
          gatewayStatus: state.gatewayStatus,
          error: null,
        });
        return;
      }
      setState({
        status: 'checking',
        token: '',
        gatewayStatus: null,
        error: null,
      });
    },
    async retry() {
      window.location.reload();
    },
  };

  return (
    <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return context;
}
