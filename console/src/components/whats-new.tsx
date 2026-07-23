import { useEffect, useState } from 'react';
import { getReleaseHighlights, LATEST_RELEASE_NOTES } from '../release-notes';
import { Button } from './button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { HybridClaw } from './icons';
import styles from './whats-new.module.css';

const SEEN_VERSION_STORAGE_KEY = 'hybridclaw_whats_new_seen_version';

function hasSeenVersion(version: string): boolean {
  try {
    return window.localStorage.getItem(SEEN_VERSION_STORAGE_KEY) === version;
  } catch {
    return false;
  }
}

function markVersionSeen(version: string): void {
  try {
    window.localStorage.setItem(SEEN_VERSION_STORAGE_KEY, version);
  } catch {
    // The popup still works when browser storage is unavailable.
  }
}

export function WhatsNew(props: {
  version: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const highlights = getReleaseHighlights(props.version);

  useEffect(() => {
    if (
      props.version !== LATEST_RELEASE_NOTES.version ||
      hasSeenVersion(props.version)
    ) {
      return;
    }
    markVersionSeen(props.version);
    setOpen(true);
  }, [props.version]);

  const releaseUrl = `https://github.com/HybridAIOne/hybridclaw/releases/tag/v${encodeURIComponent(props.version)}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={props.triggerClassName}
        aria-label={`What's new in v${props.version}`}
      >
        v{props.version}
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader className={styles.header}>
          <div className={styles.markWrap} aria-hidden="true">
            <HybridClaw className={styles.mark} />
          </div>
          <div className={styles.heading}>
            <span className={styles.eyebrow}>HybridClaw update</span>
            <DialogTitle>What&apos;s new in v{props.version}</DialogTitle>
          </div>
          <DialogDescription className={styles.srOnly}>
            Release highlights for HybridClaw v{props.version}.
          </DialogDescription>
        </DialogHeader>
        {highlights.length > 0 ? (
          <ul className={styles.highlights}>
            {highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        ) : null}
        <a
          className={styles.releaseLink}
          href={releaseUrl}
          target="_blank"
          rel="noreferrer"
        >
          Full release notes
        </a>
        <DialogFooter>
          <Button render={<DialogClose>Got it</DialogClose>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
