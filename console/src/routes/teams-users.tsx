/**
 * Teams bot users pair observed sender identities with administrator-selected agents.
 * Totals come from user-attributed usage, not shared session totals. Tab SSO setup
 * remains on the parent page and assigning an agent does not grant bot access.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  fetchAdminAgents,
  fetchMSTeamsUsers,
  saveMSTeamsUserAgent,
} from '../api/client';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { useToast } from '../components/toast';
import { getErrorMessage } from '../lib/error-message';
import styles from './teams.module.css';

export function TeamsUsers() {
  const { token } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const usersQuery = useQuery({
    queryKey: ['msteams-users', token],
    queryFn: () => fetchMSTeamsUsers(token),
    // 30s (Codex, 2026-09-10): admin polling cadence; streaming updates deferred.
    refetchInterval: 30_000,
    retry: false,
  });
  const agentsQuery = useQuery({
    queryKey: ['admin-agents', token],
    queryFn: () => fetchAdminAgents(token),
    retry: false,
  });
  const saveMutation = useMutation({
    mutationFn: ({
      userId,
      agentId,
    }: {
      userId: string;
      agentId: string | null;
    }) => saveMSTeamsUserAgent(token, userId, agentId),
    onSuccess: (payload) => {
      queryClient.setQueryData(['msteams-users', token], payload);
      toast.success('Teams user mapping saved. Applies to the next turn.');
    },
    onError: (error) =>
      toast.error(`Mapping failed: ${getErrorMessage(error)}`),
  });
  const agents = (agentsQuery.data ?? []).filter((agent) => !agent.archived);
  const needle = search.trim().toLowerCase();
  const users = (usersQuery.data?.users ?? []).filter((user) =>
    [user.userId, user.teamsUserId, user.entraObjectId, user.displayName].some(
      (value) => value?.toLowerCase().includes(needle),
    ),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bot users and agent routing</CardTitle>
        <CardDescription>
          Assign Teams users to agents and review their usage.
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.stack}>
        <p className={styles.muted}>
          Users appear after an allowed message or command to the bot. Mappings
          apply to the next turn and keep each agent’s conversation history
          separate. Teams access rules still apply.
        </p>
        <div className={styles.row}>
          <Input
            aria-label="Search Teams users"
            placeholder="Search name, Entra ID or Teams ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={usersQuery.isFetching}
            onClick={() => void usersQuery.refetch()}
          >
            Refresh users
          </Button>
        </div>
        {usersQuery.isLoading ? (
          <p>Loading Teams users…</p>
        ) : usersQuery.isError ? (
          <p role="alert">
            Could not load Teams users: {getErrorMessage(usersQuery.error)}
          </p>
        ) : users.length === 0 ? (
          <p className={styles.muted}>
            {needle
              ? 'No matching Teams users.'
              : 'No Teams bot users recorded yet.'}
          </p>
        ) : (
          <div className={styles.userTableWrap}>
            <table className={styles.userTable}>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Agent</th>
                  <th>Messages</th>
                  <th>Sessions</th>
                  <th>Tokens</th>
                  <th>Estimated cost</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.userId}>
                    <td>
                      <strong>{user.displayName || user.userId}</strong>
                      {user.entraObjectId ? (
                        <span className={styles.userIdentity}>
                          Entra: {user.entraObjectId}
                        </span>
                      ) : null}
                      {user.teamsUserId ? (
                        <span className={styles.userIdentity}>
                          Teams: {user.teamsUserId}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <NativeSelect
                        aria-label={`Agent for ${user.displayName || user.userId}`}
                        value={user.agentId || ''}
                        disabled={
                          saveMutation.isPending || !agentsQuery.isSuccess
                        }
                        onChange={(event) =>
                          saveMutation.mutate({
                            userId: user.userId,
                            agentId: event.target.value || null,
                          })
                        }
                      >
                        <NativeSelectOption value="">
                          Default ({usersQuery.data?.defaultAgentId || 'main'})
                        </NativeSelectOption>
                        {agents.map((agent) => (
                          <NativeSelectOption key={agent.id} value={agent.id}>
                            {agent.name || agent.id}
                          </NativeSelectOption>
                        ))}
                        {user.agentId &&
                        !agents.some((agent) => agent.id === user.agentId) ? (
                          <NativeSelectOption value={user.agentId}>
                            Unavailable: {user.agentId}
                          </NativeSelectOption>
                        ) : null}
                      </NativeSelect>
                    </td>
                    <td>{user.messageCount.toLocaleString()}</td>
                    <td>{user.sessionCount.toLocaleString()}</td>
                    <td>{user.totalTokens.toLocaleString()}</td>
                    <td>${user.costUsd.toFixed(4)}</td>
                    <td>
                      <time dateTime={user.lastSeen}>
                        {new Date(user.lastSeen).toLocaleString()}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {agentsQuery.isError ? (
          <p role="alert">
            Could not load agents: {getErrorMessage(agentsQuery.error)}
          </p>
        ) : null}
        <p className={styles.muted}>
          All-time usage since user tracking was enabled. Messages exclude
          commands; sessions, tokens and estimated USD costs reflect recorded
          bot turns and metered commands, including model retries. Older
          unattributed usage is excluded. Usage may take a few seconds to
          appear.
        </p>
      </CardContent>
    </Card>
  );
}
