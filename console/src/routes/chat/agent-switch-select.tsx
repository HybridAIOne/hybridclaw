import { useEffect, useRef, useState } from 'react';
import { fetchAgentAvatarBlob } from '../../api/chat';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/select';
import css from './chat-page.module.css';

export interface AgentSwitchOption {
  id: string;
  name?: string | null;
  imageUrl?: string | null;
}

function ChevronGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function AgentSwitchSelect(props: {
  agents: AgentSwitchOption[];
  selectedAgentId: string;
  token?: string;
  disabled?: boolean;
  onSwitch: (agentId: string) => void;
}) {
  if (props.agents.length === 0) return null;
  const selectedAgent = props.agents.find(
    (agent) => agent.id === props.selectedAgentId,
  );
  const selectedLabel =
    selectedAgent?.name?.trim() || selectedAgent?.id || 'Agent';

  return (
    <Select
      value={props.selectedAgentId}
      disabled={props.disabled}
      onValueChange={(agentId) => {
        if (!agentId || agentId === props.selectedAgentId) return;
        props.onSwitch(agentId);
      }}
    >
      <SelectTrigger
        className={css.composerPill}
        aria-label="Switch agent"
        disabled={props.disabled}
      >
        <SelectValue>{selectedLabel}</SelectValue>
        <SelectIcon className={css.composerPillChevron}>
          <ChevronGlyph />
        </SelectIcon>
      </SelectTrigger>
      <SelectContent className={css.agentSelectPopup}>
        {props.agents.map((agent) => (
          <SelectItem
            key={agent.id}
            value={agent.id}
            textValue={agent.name?.trim() || agent.id}
            className={css.agentSelectItem}
          >
            <AgentSelectAvatar agent={agent} token={props.token} />
            <span className={css.agentSelectItemText}>
              {agent.name?.trim() || agent.id}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AgentSelectAvatar(props: {
  agent: AgentSwitchOption;
  token?: string;
}) {
  const objectUrlRef = useRef<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const imageUrl = props.agent.imageUrl?.trim();

  useEffect(() => {
    const previous = objectUrlRef.current;
    objectUrlRef.current = null;
    if (previous) URL.revokeObjectURL(previous);
    setObjectUrl(null);

    if (!props.token || !imageUrl) return;

    let cancelled = false;
    void fetchAgentAvatarBlob(props.token, imageUrl)
      .then((blob) => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        objectUrlRef.current = next;
        setObjectUrl(next);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });

    return () => {
      cancelled = true;
      const next = objectUrlRef.current;
      objectUrlRef.current = null;
      if (next) URL.revokeObjectURL(next);
    };
  }, [imageUrl, props.token]);

  const initial = props.agent.id.charAt(0).toUpperCase();
  return objectUrl ? (
    <img className={css.agentSelectAvatar} src={objectUrl} alt="" />
  ) : (
    <span className={css.agentSelectAvatarFallback} aria-hidden="true">
      {initial || '?'}
    </span>
  );
}
