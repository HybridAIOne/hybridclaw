import { useQuery } from '@tanstack/react-query';
import { fetchAdminSecrets } from '../api/client';
import { useAuth } from '../auth';
import { NativeSelect, NativeSelectOption } from './native-select';
import styles from './secret-ref-picker.module.css';

export interface SecretRefPickerProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function CanonicalSecretStatus(props: {
  name: string;
  providerReachable?: boolean;
}) {
  const { token } = useAuth();
  const secretsQuery = useQuery({
    queryKey: ['admin', 'secrets', token],
    queryFn: () => fetchAdminSecrets(token),
    retry: false,
  });
  const entry = secretsQuery.data?.secrets.find(
    (secret) => secret.name === props.name,
  );
  const stored = entry?.state === 'set';
  const available = stored || props.providerReachable === true;
  const status = secretsQuery.isPending
    ? 'Checking…'
    : available
      ? 'Available'
      : 'Not configured';
  const description = stored
    ? 'Stored in the runtime secret store.'
    : props.providerReachable
      ? 'Available to the running provider outside the runtime secret store.'
      : secretsQuery.isError
        ? 'Credential metadata is unavailable.'
        : 'No credential is available to this provider.';

  return (
    <div
      className={styles.status}
      role="status"
      aria-label={`${props.name} credential status`}
    >
      <div className={styles.statusLine}>
        <code>{props.name}</code>
        <span
          className={available ? styles.statusAvailable : styles.statusMissing}
        >
          {status}
        </span>
      </div>
      <span className={styles.statusDescription}>{description}</span>
    </div>
  );
}

export function SecretRefPicker({
  value,
  onValueChange,
  placeholder = 'Select secret',
  disabled = false,
}: SecretRefPickerProps) {
  const { token } = useAuth();
  const secretsQuery = useQuery({
    queryKey: ['admin', 'secrets', token],
    queryFn: () => fetchAdminSecrets(token),
    retry: false,
  });
  const entries = [...(secretsQuery.data?.secrets ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const currentIsMissing =
    Boolean(value) && !entries.some((entry) => entry.name === value);

  return (
    <div className={styles.picker}>
      <NativeSelect
        value={value}
        disabled={disabled || secretsQuery.isPending}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <NativeSelectOption value="">
          {secretsQuery.isPending ? 'Loading secrets…' : placeholder}
        </NativeSelectOption>
        {currentIsMissing ? (
          <NativeSelectOption value={value}>{value}</NativeSelectOption>
        ) : null}
        {entries.map((entry) => (
          <NativeSelectOption key={entry.name} value={entry.name}>
            {entry.name}
            {entry.state === 'unset' ? ' (unset)' : ''}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className={styles.meta}>
        {secretsQuery.isError ? (
          <span role="alert">Secret names are unavailable.</span>
        ) : (
          <span>Values stay in the runtime secret store.</span>
        )}
        <a href="/admin/credentials?tab=secrets">Create new secret →</a>
      </div>
    </div>
  );
}
