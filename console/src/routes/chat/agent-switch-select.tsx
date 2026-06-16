import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/select';
import { useAgentAvatarUrl } from './agent-avatar-url';
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
  const imageUrl = props.agent.imageUrl?.trim();
  const avatar = useAgentAvatarUrl({
    token: props.token ?? '',
    imageUrl,
  });

  if (avatar.objectUrl) {
    return (
      <img className={css.agentSelectAvatar} src={avatar.objectUrl} alt="" />
    );
  }
  return imageUrl ? (
    <span className={css.agentSelectAvatarLoading} aria-hidden="true" />
  ) : null;
}
