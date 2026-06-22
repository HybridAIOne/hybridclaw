import { Server as ServerIcon } from '../../components/icons';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectIcon,
  SelectItem,
  SelectItemBody,
  SelectItemSubtitle,
  SelectTrigger,
  SelectValue,
} from '../../components/select';
import { useAgentAvatarUrl } from './agent-avatar-url';
import css from './chat-page.module.css';

export interface AgentSwitchOption {
  id: string;
  name?: string | null;
  imageUrl?: string | null;
  source?:
    | { type: 'local' }
    | {
        type: 'remote';
        peerId: string;
        instanceId: string;
        label: string;
      };
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
  onSwitch: (agent: AgentSwitchOption) => void;
}) {
  if (props.agents.length === 0) return null;
  const selectedAgent = props.agents.find(
    (agent) => agent.id === props.selectedAgentId,
  );
  const selectedLabel =
    selectedAgent?.name?.trim() || selectedAgent?.id || 'Agent';
  const localAgents = props.agents.filter(
    (agent) => agent.source?.type !== 'remote',
  );
  const remoteGroups = new Map<string, AgentSwitchOption[]>();
  for (const agent of props.agents) {
    if (agent.source?.type !== 'remote') continue;
    const label = agent.source.label || agent.source.instanceId;
    remoteGroups.set(label, [...(remoteGroups.get(label) ?? []), agent]);
  }
  const hasRemoteAgents = remoteGroups.size > 0;

  return (
    <Select
      value={props.selectedAgentId}
      disabled={props.disabled}
      onValueChange={(agentId) => {
        if (!agentId || agentId === props.selectedAgentId) return;
        const agent = props.agents.find((option) => option.id === agentId);
        if (agent) props.onSwitch(agent);
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
        {hasRemoteAgents ? (
          <SelectGroup>
            <SelectGroupLabel>Local</SelectGroupLabel>
            {localAgents.map((agent) => (
              <AgentSelectItem
                key={agent.id}
                agent={agent}
                token={props.token}
              />
            ))}
          </SelectGroup>
        ) : (
          localAgents.map((agent) => (
            <AgentSelectItem key={agent.id} agent={agent} token={props.token} />
          ))
        )}
        {[...remoteGroups.entries()].map(([label, agents]) => (
          <SelectGroup key={label}>
            <SelectGroupLabel className={css.remoteAgentGroupLabel}>
              <ServerIcon
                aria-hidden="true"
                className={css.remoteAgentGroupIcon}
                width={13}
                height={13}
              />
              <span>{label}</span>
            </SelectGroupLabel>
            {agents.map((agent) => (
              <AgentSelectItem
                key={agent.id}
                agent={agent}
                token={props.token}
              />
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function AgentSelectItem(props: { agent: AgentSwitchOption; token?: string }) {
  const label = props.agent.name?.trim() || props.agent.id;
  const isRemote = props.agent.source?.type === 'remote';
  return (
    <SelectItem
      value={props.agent.id}
      textValue={label}
      className={css.agentSelectItem}
    >
      <AgentSelectAvatar agent={props.agent} token={props.token} />
      {isRemote ? (
        <SelectItemBody>
          <span className={css.agentSelectItemText}>{label}</span>
          <SelectItemSubtitle>{props.agent.id}</SelectItemSubtitle>
        </SelectItemBody>
      ) : (
        <span className={css.agentSelectItemText}>{label}</span>
      )}
    </SelectItem>
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
