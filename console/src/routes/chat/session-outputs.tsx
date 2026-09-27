/**
 * Session outputs — top-bar list of every artifact attached to the loaded
 * messages of the current chat, newest first, one row per file path.
 *
 * Derived from the messages the page already holds; it never fetches a
 * session-wide artifact index, so artifacts in unloaded history pages are
 * absent. The inline per-message artifact cards stay the primary surface.
 */
import { useMemo, useState } from 'react';
import type { ChatArtifact } from '../../api/chat-types';
import { Files } from '../../components/icons';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '../../components/popover';
import type { ChatUiMessage } from './chat-ui-message';
import { downloadArtifact } from './message-block';
import css from './session-outputs.module.css';

type DownloadableArtifact = ChatArtifact & { path: string };

export function collectSessionOutputs(
  messages: readonly ChatUiMessage[],
): DownloadableArtifact[] {
  const seen = new Set<string>();
  const outputs: DownloadableArtifact[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const artifacts = messages[i].artifacts ?? [];
    for (let j = artifacts.length - 1; j >= 0; j--) {
      const artifact = artifacts[j];
      if (!artifact.path || seen.has(artifact.path)) continue;
      seen.add(artifact.path);
      outputs.push(artifact as DownloadableArtifact);
    }
  }
  return outputs;
}

function artifactName(artifact: DownloadableArtifact): string {
  return artifact.filename ?? artifact.path.split('/').pop() ?? 'artifact';
}

function extensionLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

export function SessionOutputs(props: {
  messages: readonly ChatUiMessage[];
  token: string;
}) {
  const [open, setOpen] = useState(false);
  const outputs = useMemo(
    () => collectSessionOutputs(props.messages),
    [props.messages],
  );
  if (outputs.length === 0) return null;

  const label = `${outputs.length} output${outputs.length === 1 ? '' : 's'}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor>
        <button
          type="button"
          className={css.trigger}
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Files width={16} height={16} />
          <span>{outputs.length}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        className={css.popover}
        align="end"
        sideOffset={6}
        role="dialog"
        aria-label="Outputs"
      >
        <div className={css.header}>Outputs</div>
        <ul className={css.list}>
          {outputs.map((artifact) => {
            const name = artifactName(artifact);
            return (
              <li key={artifact.path}>
                <button
                  type="button"
                  className={css.row}
                  title={`Download ${name}`}
                  onClick={() => void downloadArtifact(props.token, artifact)}
                >
                  <span className={css.name}>{name}</span>
                  <span className={css.kind}>{extensionLabel(name)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
