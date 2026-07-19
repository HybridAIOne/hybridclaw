import { Link } from '@tanstack/react-router';
import styles from './managed-elsewhere-banner.module.css';
import type { AdminConfigSectionOwner } from './sidebar/navigation';

export function ManagedElsewhereBanner({
  owner,
}: {
  owner: AdminConfigSectionOwner;
}) {
  return (
    <aside className={styles.banner} aria-label="Managed elsewhere">
      <div>
        <strong>Managed elsewhere</strong>
        <span>This section is managed on the {owner.label} page.</span>
      </div>
      <Link to={owner.to}>Open {owner.label} →</Link>
    </aside>
  );
}
