import styles from './provider-health.module.css';

const LOCAL_PROVIDER_NAMES = new Set([
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
]);

type HealthStatus = 'healthy' | 'warning' | 'catalog' | 'inactive' | 'down';

export interface ProviderEntry {
  kind?: 'local' | 'remote';
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  modelCount?: number;
  detail?: string;
  loginRequired?: boolean;
  catalogOnly?: boolean;
}

function resolveStatus(name: string, provider: ProviderEntry): HealthStatus {
  if (provider.catalogOnly) return 'catalog';
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
  catalog: styles.dotCatalog,
  down: styles.dotDown,
  inactive: styles.dotInactive,
};

interface ProviderRowProps {
  name: string;
  provider: ProviderEntry;
  onLogin?: () => void;
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
          <span
            className={`${styles.dot} ${DOT_CLASS[status]}`}
            aria-hidden="true"
          />
          <span className={styles.name}>{name}</span>
          <span
            className={`${styles.badge} ${isLocal ? styles.badgeLocal : styles.badgeRemote}`}
          >
            {isLocal ? 'local' : 'remote'}
          </span>
        </div>
        <div className={styles.meta}>
          <span className={styles.detail} title={detail}>
            {detail}
          </span>
          <span className={styles.modelCount}>
            {modelCount} {modelCount === 1 ? 'model' : 'models'}
          </span>
          <span className={styles.statusLabel}>{status}</span>
          {provider.loginRequired && onLogin ? (
            <button type="button" className={styles.loginBtn} onClick={onLogin}>
              Log in →
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface ProviderHealthProps {
  title: string;
  entries: Array<[string, ProviderEntry]>;
  variant?: 'full' | 'compact';
  onLogin?: () => void;
  onManage?: () => void;
}

export function ProviderHealth({
  title,
  entries,
  variant = 'full',
  onLogin,
  onManage,
}: ProviderHealthProps) {
  // Split into active (visible rows) and inactive (collapsed footer)
  const activeEntries = entries.filter(([name, p]) => {
    const status = resolveStatus(name, p);
    return status !== 'inactive';
  });

  const inactiveEntries = entries.filter(([name, p]) => {
    const status = resolveStatus(name, p);
    return status === 'inactive';
  });
  const healthyCount = entries.filter(
    ([name, provider]) => resolveStatus(name, provider) === 'healthy',
  ).length;
  const attentionCount = entries.filter(([name, provider]) => {
    const status = resolveStatus(name, provider);
    return status === 'warning' || status === 'down';
  }).length;
  const catalogCount = entries.filter(
    ([name, provider]) => resolveStatus(name, provider) === 'catalog',
  ).length;

  if (variant === 'compact') {
    return (
      <section className={`${styles.panel} ${styles.panelCompact}`}>
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>{title}</span>
          {onManage ? (
            <button
              type="button"
              className={styles.manageBtn}
              onClick={onManage}
            >
              Manage providers →
            </button>
          ) : null}
        </div>
        <div className={styles.compactBody}>
          {entries.length === 0 ? (
            <span>No provider health data available.</span>
          ) : (
            <>
              <span className={styles.compactSummary}>
                <strong>{healthyCount}</strong> healthy
                {attentionCount > 0 ? (
                  <>
                    {' · '}
                    <strong className={styles.compactAttention}>
                      {attentionCount}
                    </strong>{' '}
                    need attention
                  </>
                ) : null}
                {catalogCount > 0 ? ` · ${catalogCount} catalog only` : ''}
                {inactiveEntries.length > 0
                  ? ` · ${inactiveEntries.length} inactive`
                  : ''}
              </span>
              <div className={styles.compactProviders}>
                {activeEntries.slice(0, 6).map(([name, provider]) => {
                  const status = resolveStatus(name, provider);
                  return (
                    <span className={styles.compactProvider} key={name}>
                      <span
                        className={`${styles.dot} ${DOT_CLASS[status]}`}
                        aria-hidden="true"
                      />
                      {name}
                    </span>
                  );
                })}
                {activeEntries.length > 6 ? (
                  <span className={styles.compactOverflow}>
                    +{activeEntries.length - 6}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

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
