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
        <a href="/admin/secrets">Create new secret →</a>
      </div>
    </div>
  );
}
