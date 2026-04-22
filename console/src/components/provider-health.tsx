import styles from './provider-health.module.css';

const LOCAL_PROVIDER_NAMES = new Set([
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
]);

type HealthStatus = 'healthy' | 'warning' | 'inactive' | 'down';

export interface ProviderEntry {
  kind?: 'local' | 'remote';
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  modelCount?: number;
  detail?: string;
  loginRequired?: boolean;
}

function resolveStatus(name: string, provider: ProviderEntry): HealthStatus {
  if (provider.loginRequired) return 'warning';
  if (!provider.reachable) {
    const isLocal = provider.kind === 'local' || LOCAL_PROVIDER_NAMES.has(name);
    return isLocal ? 'inactive' : 'down';
  }
  return 'healthy';
}

function isLocalProvider(name: string, provider: ProviderEntry): boolean {
  return provider.kind === 'local' || LOCAL_PROVIDER_NAMES.has(name);
}

const DOT_CLASS: Record<HealthStatus, string> = {
  healthy: styles.dotHealthy,
  warning: styles.dotWarning,
  down: styles.dotDown,
  inactive: styles.dotInactive,
};

interface ProviderRowProps {
  name: string;
  provider: ProviderEntry;
  onLogin: () => void;
}

function ProviderRow({ name, provider, onLogin }: ProviderRowProps) {
  const status = resolveStatus(name, provider);
  const isLocal = isLocalProvider(name, provider);
  const modelCount = provider.modelCount ?? 0;

  const detail = provider.detail
    ? provider.detail
    : provider.reachable
      ? `${provider.latencyMs ?? 0}ms`
      : provider.error || 'unreachable';

  const rowClass = [
    styles.row,
    status === 'warning' ? styles.rowWarning : '',
    status === 'down' ? styles.rowDown : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClass}>
      <div className={styles.rowTop}>
        <div className={styles.nameGroup}>
          <span className={`${styles.dot} ${DOT_CLASS[status]}`} />
          <span className={styles.name}>{name}</span>
          <span
            className={`${styles.badge} ${isLocal ? styles.badgeLocal : styles.badgeRemote}`}
          >
            {isLocal ? 'local' : 'remote'}
          </span>
        </div>
        <div className={styles.meta}>
          <span className={styles.detail}>{detail}</span>
          <span className={styles.modelCount}>
            {modelCount} {modelCount === 1 ? 'model' : 'models'}
          </span>
          {provider.loginRequired && (
            <button type="button" className={styles.loginBtn} onClick={onLogin}>
              Log in →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ProviderHealthPanelProps {
  title: string;
  entries: Array<[string, ProviderEntry]>;
  onLogin: () => void;
}

export function ProviderHealthPanel({
  title,
  entries,
  onLogin,
}: ProviderHealthPanelProps) {
  // Split into active (visible rows) and inactive (collapsed footer)
  const activeEntries = entries.filter(([name, p]) => {
    const status = resolveStatus(name, p);
    return status !== 'inactive';
  });

  const inactiveEntries = entries.filter(([name, p]) => {
    const status = resolveStatus(name, p);
    return status === 'inactive';
  });

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>{title}</span>
      </div>

      {entries.length === 0 ? (
        <p className={styles.panelEmpty}>No provider health data available.</p>
      ) : (
        <>
          {activeEntries.map(([name, provider]) => (
            <ProviderRow
              key={name}
              name={name}
              provider={provider}
              onLogin={onLogin}
            />
          ))}
          {inactiveEntries.length > 0 && (
            <div className={styles.inactiveFooter}>
              <span className={styles.inactiveDot} />
              <span>
                <span className={styles.inactiveNames}>
                  {inactiveEntries.map(([n]) => n).join(' · ')}
                </span>{' '}
                not running locally
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export { ProviderRow as ProviderHealthRow };
