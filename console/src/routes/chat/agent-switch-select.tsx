import css from './chat-page.module.css';

export interface AgentSwitchOption {
  id: string;
  name?: string | null;
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
  disabled?: boolean;
  onSwitch: (agentId: string) => void;
}) {
  if (props.agents.length === 0) return null;

  return (
    <span
      className={css.composerPill}
      data-disabled={props.disabled ? '' : undefined}
    >
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
      <span aria-hidden="true" className={css.composerPillChevron}>
        <ChevronGlyph />
      </span>
    </span>
  );
}
