import css from './chat-page.module.css';

export interface AgentSwitchOption {
  id: string;
  name?: string | null;
}

export function AgentSwitchSelect(props: {
  agents: AgentSwitchOption[];
  selectedAgentId: string;
  disabled?: boolean;
  onSwitch: (agentId: string) => void;
}) {
  if (props.agents.length === 0) return null;

  return (
    <select
      className={css.agentSelect}
      value={props.selectedAgentId}
      disabled={props.disabled}
      aria-label="Switch agent"
      onChange={(event) => {
        const nextAgentId = event.target.value;
        if (!nextAgentId || nextAgentId === props.selectedAgentId) return;
        props.onSwitch(nextAgentId);
      }}
    >
      {props.agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name?.trim() || agent.id}
        </option>
      ))}
    </select>
  );
}
