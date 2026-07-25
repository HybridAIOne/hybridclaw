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
  selected?: boolean;
  onSelect?: (name: string) => void;
}

function ProviderRow({
  name,
  provider,
  selected = false,
  onSelect,
}: ProviderRowProps) {
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
    onSelect ? styles.rowButton : '',
    selected ? styles.rowSelected : '',
    status === 'warning' ? styles.rowWarning : '',
    status === 'down' ? styles.rowDown : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
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
        </div>
      </div>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={rowClass}
        aria-pressed={selected}
        onClick={() => onSelect(name)}
      >
        {content}
      </button>
    );
  }

  return <div className={rowClass}>{content}</div>;
}

export interface ProviderHealthProps {
  title: string;
  entries: Array<[string, ProviderEntry]>;
  selectedName?: string | null;
  onSelect?: (name: string) => void;
}

function isInactiveEntry([name, provider]: [string, ProviderEntry]): boolean {
  return resolveStatus(name, provider) === 'inactive';
}

function isActiveEntry(entry: [string, ProviderEntry]): boolean {
  return !isInactiveEntry(entry);
}

function renderProviderRow(
  [name, provider]: [string, ProviderEntry],
  props: ProviderHealthProps,
) {
  return (
    <ProviderRow
      key={name}
      name={name}
      provider={provider}
      selected={props.selectedName === name}
      onSelect={props.onSelect}
    />
  );
}

export function ProviderHealth(props: ProviderHealthProps) {
  const { title, entries } = props;
  const activeEntries = props.onSelect
    ? entries
    : entries.filter(isActiveEntry);
  const inactiveEntries = props.onSelect ? [] : entries.filter(isInactiveEntry);
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>{title}</span>
      </div>

      {entries.length === 0 ? (
        <p className={styles.panelEmpty}>No provider health data available.</p>
      ) : (
        <>
          {activeEntries.map((entry) => renderProviderRow(entry, props))}
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
