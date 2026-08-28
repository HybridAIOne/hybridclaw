/**
 * Agent configuration tab — the console's editor for one agent's runtime
 * settings (name, model, workspace, skill allowlist, tool allowlist).
 *
 * Edits stay local until Save, and Save sends the whole editable set in one
 * PUT so a half-applied agent is never persisted. Skill and tool allowlists
 * are sent as `null` when unrestricted, which is what clears them server-side.
 *
 * NOT the workspace-file editor (`agents.tsx` owns AGENTS.md and friends) and
 * NOT the global skill/tool catalogs (`/admin/skills`, `/admin/extensions`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  deleteAdminAgent,
  fetchAdminAgents,
  fetchModels,
  fetchSkills,
  fetchTools,
  updateAdminAgent,
} from '../api/client';
import type { AdminAgent } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { Field, FieldDescription, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { useToast } from '../components/toast';
import { SegmentedToggle } from '../components/ui';
import { DEFAULT_AGENT_ID } from '../lib/chat-helpers';
import { getErrorMessage } from '../lib/error-message';
import styles from './agent-config.module.css';
import { type AgentScopeGroup, AgentScopePicker } from './agent-scope-picker';
import { ModelSwitchSelect } from './chat/model-switch-select';

interface AgentDraft {
  name: string;
  model: string;
  workspace: string;
  skills: string[] | null;
  tools: string[] | null;
}

function toDraft(agent: AdminAgent): AgentDraft {
  return {
    name: agent.name || '',
    model: agent.model || '',
    workspace: agent.workspace || '',
    skills: agent.skills ? [...agent.skills] : null,
    tools: agent.tools ? [...agent.tools] : null,
  };
}

function sameSelection(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function isDirtyDraft(draft: AgentDraft, agent: AdminAgent): boolean {
  const base = toDraft(agent);
  return (
    draft.name !== base.name ||
    draft.model !== base.model ||
    draft.workspace !== base.workspace ||
    !sameSelection(draft.skills, base.skills) ||
    !sameSelection(draft.tools, base.tools)
  );
}

/** Appends configured entries the catalog cannot account for. */
function withUnknownEntries(
  groups: AgentScopeGroup[],
  selected: string[] | null,
): AgentScopeGroup[] {
  if (!selected) return groups;
  const known = new Set(groups.flatMap((g) => g.items.map((item) => item.id)));
  const unknown = selected.filter((entry) => !known.has(entry));
  if (unknown.length === 0) return groups;
  return [
    ...groups,
    {
      label: 'Not in catalog',
      items: unknown.map((entry) => ({
        id: entry,
        label: entry,
        badges: ['unlisted'],
      })),
    },
  ];
}

function AgentOverview(props: {
  agents: AdminAgent[];
  onSelect: (agentId: string) => void;
}) {
  return (
    <div className={styles.overviewGrid}>
      {props.agents.map((agent) => (
        <button
          className={styles.overviewCard}
          key={agent.id}
          type="button"
          onClick={() => props.onSelect(agent.id)}
        >
          <strong>{agent.name || agent.id}</strong>
          <code>{agent.id}</code>
          <span className="supporting-text">
            {agent.model || 'default model'}
          </span>
          <span className={styles.overviewCounts}>
            <em>
              {agent.skills ? `${agent.skills.length} skills` : 'all skills'}
            </em>
            <em>{agent.tools ? `${agent.tools.length} tools` : 'all tools'}</em>
          </span>
        </button>
      ))}
    </div>
  );
}

export function AgentConfigPage(props: {
  selectedAgentId?: string;
  onAgentChange: (agentId: string) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [draftAgentId, setDraftAgentId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  const agentsQuery = useQuery({
    queryKey: ['admin-agents', auth.token],
    queryFn: () => fetchAdminAgents(auth.token),
  });
  const skillsQuery = useQuery({
    queryKey: ['admin-skills', auth.token],
    queryFn: () => fetchSkills(auth.token),
  });
  const toolsQuery = useQuery({
    queryKey: ['admin-tools', auth.token],
    queryFn: () => fetchTools(auth.token),
  });
  const modelsQuery = useQuery({
    queryKey: ['admin-models', auth.token],
    queryFn: () => fetchModels(auth.token),
  });

  const activeAgents = useMemo(
    () => (agentsQuery.data || []).filter((agent) => !agent.archived),
    [agentsQuery.data],
  );
  const agent =
    activeAgents.find((entry) => entry.id === props.selectedAgentId) || null;

  if (agent && draftAgentId !== agent.id) {
    setDraftAgentId(agent.id);
    setDraft(toDraft(agent));
  }

  const skillGroups = useMemo<AgentScopeGroup[]>(() => {
    const byCategory = new Map<string, AgentScopeGroup>();
    for (const skill of skillsQuery.data?.skills || []) {
      const label = skill.category || 'Uncategorized';
      let group = byCategory.get(label);
      if (!group) {
        group = { label, items: [] };
        byCategory.set(label, group);
      }
      const badges: string[] = [];
      if (!skill.available) badges.push('unavailable');
      else if (!skill.enabled) badges.push('off globally');
      if (skill.blocked) badges.push('blocked');
      group.items.push({
        id: skill.name,
        label: skill.name,
        description: skill.shortDescription || skill.description,
        ...(badges.length > 0 ? { badges } : {}),
      });
    }
    return [...byCategory.values()].sort((left, right) =>
      left.label.localeCompare(right.label),
    );
  }, [skillsQuery.data]);

  const toolGroups = useMemo<AgentScopeGroup[]>(
    () =>
      (toolsQuery.data?.groups || []).map((group) => ({
        label: group.label,
        items: group.tools.map((tool) => ({
          id: tool.name,
          label: tool.name,
          ...(tool.kind === 'builtin' ? {} : { badges: [tool.kind] }),
        })),
      })),
    [toolsQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: async (input: { agentId: string; draft: AgentDraft }) =>
      updateAdminAgent(auth.token, input.agentId, {
        name: input.draft.name.trim(),
        model: input.draft.model.trim(),
        workspace: input.draft.workspace.trim(),
        skills: input.draft.skills,
        tools: input.draft.tools,
      }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({
        queryKey: ['admin-agents', auth.token],
      });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setDraftAgentId(saved.id);
      setDraft(toDraft(saved));
      toast.success('Agent saved', `${saved.name || saved.id} updated.`);
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (agentId: string) =>
      deleteAdminAgent(auth.token, agentId),
    onSuccess: (_result, agentId) => {
      void queryClient.invalidateQueries({
        queryKey: ['admin-agents', auth.token],
      });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setDeleteDialogOpen(false);
      setDeleteConfirmation('');
      props.onAgentChange('');
      toast.success('Agent deleted', `${agentId} was removed.`);
    },
    onError: (error) => {
      toast.error('Delete failed', getErrorMessage(error));
    },
  });

  if (agentsQuery.isLoading) {
    return <div className="empty-state">Loading agents...</div>;
  }
  if (agentsQuery.isError) {
    return (
      <div className="empty-state">
        Failed to load agents: {getErrorMessage(agentsQuery.error)}
      </div>
    );
  }
  if (!agent || !draft) {
    return (
      <div className="detail-stack">
        <p className="supporting-text">Pick an agent to configure.</p>
        <AgentOverview agents={activeAgents} onSelect={props.onAgentChange} />
      </div>
    );
  }

  const dirty = isDirtyDraft(draft, agent);
  const defaultModel = modelsQuery.data?.defaultModel || 'the default model';

  return (
    <div className="detail-stack">
      <section className={styles.scopeCard}>
        <header className={styles.scopeHeader}>
          <div>
            <h3 className={styles.scopeTitle}>Identity</h3>
            <p className="supporting-text">
              How this agent introduces itself and where its workspace lives.
            </p>
          </div>
          <code className={styles.agentId}>{agent.id}</code>
        </header>

        <div className="field-grid">
          <Field>
            <FieldLabel>Display name</FieldLabel>
            <Input
              value={draft.name}
              placeholder={agent.id}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
            <FieldDescription>
              Shown in chat, selectors, and the org chart.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Workspace</FieldLabel>
            <Input
              value={draft.workspace}
              placeholder={agent.id}
              onChange={(event) =>
                setDraft({ ...draft, workspace: event.target.value })
              }
            />
            <FieldDescription>
              Workspace directory name. Empty uses the agent id.
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel>Model</FieldLabel>
          <div className={styles.modelRow}>
            <SegmentedToggle
              ariaLabel="Model source"
              size="sm"
              value={draft.model ? 'pinned' : 'default'}
              options={[
                { value: 'default', label: 'Runtime default' },
                { value: 'pinned', label: 'Pinned model' },
              ]}
              onChange={(mode) =>
                setDraft({
                  ...draft,
                  model:
                    mode === 'default'
                      ? ''
                      : draft.model || modelsQuery.data?.defaultModel || '',
                })
              }
            />
            {draft.model ? (
              <ModelSwitchSelect
                models={modelsQuery.data?.models || []}
                selectedModelId={draft.model}
                disabled={modelsQuery.isLoading}
                onSwitch={(model) => setDraft({ ...draft, model })}
              />
            ) : (
              <span className="supporting-text">
                Follows the runtime default ({defaultModel}).
              </span>
            )}
          </div>
        </Field>
      </section>

      <AgentScopePicker
        title="Skills"
        description="Skills this agent may load. Everything else stays out of its prompt."
        allLabel="All skills"
        restrictedNote="Only the selected skills load. Skills installed later stay off for this agent until you add them here."
        searchPlaceholder="Search skills"
        groups={withUnknownEntries(skillGroups, draft.skills)}
        value={draft.skills}
        loading={skillsQuery.isLoading}
        onChange={(skills) => setDraft({ ...draft, skills })}
      />

      <AgentScopePicker
        title="Tools"
        description="Tools this agent may call. Globally disabled tools stay off regardless."
        allLabel="All tools"
        restrictedNote="Only the selected tools are offered to the model. Plugin and MCP tools added later stay off for this agent until you add them here."
        searchPlaceholder="Search tools"
        groups={withUnknownEntries(toolGroups, draft.tools)}
        value={draft.tools}
        loading={toolsQuery.isLoading}
        allowCustomEntries
        onChange={(tools) => setDraft({ ...draft, tools })}
      />

      {agent.id === DEFAULT_AGENT_ID ? null : (
        <section className={styles.dangerCard}>
          <div>
            <strong>Delete this agent</strong>
            <p className="supporting-text">
              Removes the agent registration. Its workspace files stay on disk.
              Archive instead to keep it out of selectors without deleting.
            </p>
          </div>
          <Button variant="outline" onClick={() => setDeleteDialogOpen(true)}>
            Delete agent
          </Button>
        </section>
      )}

      {dirty ? (
        <div className={styles.saveBar}>
          <span>Unsaved changes</span>
          <div className="button-row">
            <Button
              variant="ghost"
              disabled={saveMutation.isPending}
              onClick={() => setDraft(toDraft(agent))}
            >
              Discard
            </Button>
            <Button
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate({ agentId: agent.id, draft })}
            >
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setDeleteConfirmation('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {agent.name || agent.id}</DialogTitle>
            <DialogDescription>
              Sessions keep their history, but the agent disappears from every
              selector and can no longer be addressed. Type the agent id to
              confirm.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Agent id</FieldLabel>
            <Input
              value={deleteConfirmation}
              placeholder={agent.id}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteConfirmation.trim() !== agent.id}
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(agent.id)}
            >
              Delete agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
