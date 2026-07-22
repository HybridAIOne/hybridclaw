import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { fetchAdminAgents, updateAdminAgent } from '../api/client';
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
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { TabbedPage } from '../components/tabbed-page';
import { useToast } from '../components/toast';
import { DEFAULT_AGENT_ID } from '../lib/chat-helpers';
import { getErrorMessage } from '../lib/error-message';
import { logNavigationError } from '../lib/navigation';
import { AgentsPage } from './agent-scoreboard';
import { AgentFilesPage } from './agents';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';

const AGENT_TABS = [
  { id: 'scoreboard', label: 'Scoreboard' },
  { id: 'files', label: 'Workspace files' },
] as const;

type AgentTab = (typeof AGENT_TABS)[number]['id'];

export function AgentsHubPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
    agent?: string;
    file?: string;
  };
  const queryClient = useQueryClient();
  const toast = useToast();
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [selectedArchiveIds, setSelectedArchiveIds] = useState<Set<string>>(
    () => new Set(),
  );
  const agentsQuery = useQuery({
    queryKey: ['admin-agents', auth.token],
    queryFn: () => fetchAdminAgents(auth.token),
  });
  const activeAgents = useMemo(
    () => (agentsQuery.data || []).filter((agent) => !agent.archived),
    [agentsQuery.data],
  );
  const archivedAgents = useMemo(
    () => (agentsQuery.data || []).filter((agent) => agent.archived),
    [agentsQuery.data],
  );
  const activeTab = readRouteTab<AgentTab>(
    search.tab,
    AGENT_TABS,
    'scoreboard',
  );
  const selectedAgentId = activeAgents.some(
    (agent) => agent.id === search.agent,
  )
    ? search.agent
    : undefined;

  const archiveMutation = useMutation({
    mutationFn: async (input: { agentIds: string[]; archived: boolean }) =>
      Promise.all(
        input.agentIds.map((agentId) =>
          updateAdminAgent(auth.token, agentId, {
            archived: input.archived,
          }),
        ),
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['admin-agents', auth.token],
      });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-scoreboard'] });
      setSelectedArchiveIds(new Set());
      if (input.archived) setArchiveDialogOpen(false);
      toast.success(
        input.archived ? 'Agents archived' : 'Agent restored',
        `${input.agentIds.length} agent${input.agentIds.length === 1 ? '' : 's'} updated.`,
      );
    },
    onError: (error) => {
      toast.error('Agent update failed', getErrorMessage(error));
    },
  });

  function updateSearch(patch: Partial<typeof search>): void {
    void navigate({
      to: '/admin/agents',
      search: mergeRouteSearch(search, patch),
      replace: true,
    }).catch(logNavigationError);
  }

  function toggleArchiveSelection(agentId: string): void {
    setSelectedArchiveIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  return (
    <>
      <TabbedPage
        tabs={AGENT_TABS}
        activeTab={activeTab}
        actions={
          <div className="header-actions">
            <label className="header-actions">
              <span className="supporting-text">Agent</span>
              <NativeSelect
                aria-label="Agent"
                value={selectedAgentId || ''}
                onChange={(event) =>
                  updateSearch({ agent: event.target.value || undefined })
                }
              >
                <NativeSelectOption value="">
                  All active agents
                </NativeSelectOption>
                {activeAgents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name ? `${agent.name} (${agent.id})` : agent.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <Button
              variant="outline"
              onClick={() => setArchiveDialogOpen(true)}
            >
              Archive agents
            </Button>
          </div>
        }
        onTabChange={(tab) => updateSearch({ tab })}
      >
        {activeTab === 'files' ? (
          <AgentFilesPage
            embedded
            selectedAgentId={selectedAgentId}
            onAgentChange={(agentId) => updateSearch({ agent: agentId })}
          />
        ) : (
          <AgentsPage
            selectedAgentId={selectedAgentId}
            activeAgentIds={activeAgents.map((agent) => agent.id)}
          />
        )}
      </TabbedPage>

      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Archive agents</DialogTitle>
            <DialogDescription>
              Archived agents keep their files and history but disappear from
              agent selectors across the console.
            </DialogDescription>
          </DialogHeader>

          <div className="agents-archive-list">
            {activeAgents.filter((agent) => agent.id !== DEFAULT_AGENT_ID)
              .length ? (
              activeAgents
                .filter((agent) => agent.id !== DEFAULT_AGENT_ID)
                .map((agent) => (
                  <label className="agents-archive-row" key={agent.id}>
                    <input
                      type="checkbox"
                      checked={selectedArchiveIds.has(agent.id)}
                      onChange={() => toggleArchiveSelection(agent.id)}
                    />
                    <span>
                      <strong>{agent.name || agent.id}</strong>
                      <small>{agent.id}</small>
                    </span>
                  </label>
                ))
            ) : (
              <div className="empty-state">
                No active agents can be archived.
              </div>
            )}
          </div>

          {archivedAgents.length ? (
            <div className="agents-archived-section">
              <strong>Archived</strong>
              {archivedAgents.map((agent) => (
                <div className="agents-archived-row" key={agent.id}>
                  <span>{agent.name || agent.id}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={archiveMutation.isPending}
                    onClick={() =>
                      archiveMutation.mutate({
                        agentIds: [agent.id],
                        archived: false,
                      })
                    }
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={selectedArchiveIds.size === 0}
              loading={archiveMutation.isPending}
              onClick={() =>
                archiveMutation.mutate({
                  agentIds: [...selectedArchiveIds],
                  archived: true,
                })
              }
            >
              Archive selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
