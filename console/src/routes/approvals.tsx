import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import {
  deleteAdminPolicyRule,
  fetchAdminApprovals,
  saveAdminPolicyDefault,
  saveAdminPolicyPreset,
  saveAdminPolicyRule,
} from '../api/client';
import type { AdminPolicyRule, AdminPolicyRuleInput } from '../api/types';
import { useAuth } from '../auth';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { useToast } from '../components/toast';
import { MetricCard, PageHeader, Panel } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatRelativeTime } from '../lib/format';

interface PolicyRuleDraft {
  action: 'allow' | 'deny';
  host: string;
  port: string;
  methods: string;
  paths: string;
  agent: string;
  comment: string;
}

function formatPendingTrustScopes(params: {
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
}): string {
  const scopes = ['once'];
  if (params.allowSession) scopes.push('session');
  if (params.allowAgent) scopes.push('agent');
  if (params.allowAll) scopes.push('all');
  return scopes.join(', ');
}

function formatRuleComment(rule: AdminPolicyRule): string {
  if (rule.comment && rule.managedByPreset) {
    return `${rule.comment} · preset:${rule.managedByPreset}`;
  }
  if (rule.comment) return rule.comment;
  if (rule.managedByPreset) return `preset:${rule.managedByPreset}`;
  return '';
}

function createEmptyPolicyRuleDraft(agentId: string): PolicyRuleDraft {
  return {
    action: 'allow',
    host: '',
    port: '*',
    methods: '*',
    paths: '/**',
    agent: agentId || '*',
    comment: '',
  };
}

function createPolicyRuleDraftFromRule(rule: AdminPolicyRule): PolicyRuleDraft {
  return {
    action: rule.action,
    host: rule.host,
    port: String(rule.port),
    methods: rule.methods.join(', '),
    paths: rule.paths.join(', '),
    agent: rule.agent,
    comment: rule.comment || '',
  };
}

function parseDraftList(value: string, fallback: string[]): string[] {
  const normalized = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function parseDraftPort(value: string): number | '*' {
  const normalized = value.trim();
  if (!normalized || normalized === '*') return '*';
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Port must be `*` or a whole number from 1 to 65535.');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error('Port must be `*` or a whole number from 1 to 65535.');
  }
  return parsed;
}

function buildPolicyRuleInput(draft: PolicyRuleDraft): AdminPolicyRuleInput {
  const host = draft.host.trim();
  if (!host) {
    throw new Error('Host is required.');
  }
  const agent = draft.agent.trim() || '*';
  const comment = draft.comment.trim();
  return {
    action: draft.action,
    host,
    port: parseDraftPort(draft.port),
    methods: parseDraftList(draft.methods, ['*']),
    paths: parseDraftList(draft.paths, ['/**']),
    agent,
    ...(comment ? { comment } : {}),
  };
}

export function ApprovalsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedPresetName, setSelectedPresetName] = useState('');
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingRuleIndex, setEditingRuleIndex] = useState<number | null>(null);
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<AdminPolicyRule | null>(
    null,
  );
  const [draft, setDraft] = useState<PolicyRuleDraft>(() =>
    createEmptyPolicyRuleDraft('main'),
  );

  const approvalsQuery = useQuery({
    queryKey: ['admin-approvals', auth.token, selectedAgentId],
    queryFn: () =>
      fetchAdminApprovals(
        auth.token,
        selectedAgentId ? { agentId: selectedAgentId } : undefined,
      ),
  });

  const activeAgentId =
    selectedAgentId || approvalsQuery.data?.selectedAgentId || 'main';
  const agents = approvalsQuery.data?.agents || [];

  useEffect(() => {
    setEditorMode(null);
    setEditingRuleIndex(null);
    setDraft(createEmptyPolicyRuleDraft(activeAgentId));
  }, [activeAgentId]);

  function resetDraft(): void {
    setEditorMode(null);
    setEditingRuleIndex(null);
    setDraft(createEmptyPolicyRuleDraft(activeAgentId));
  }

  function beginCreateRule(): void {
    setEditorMode('create');
    setEditingRuleIndex(null);
    setDraft(createEmptyPolicyRuleDraft(activeAgentId));
  }

  const saveMutation = useMutation({
    mutationFn: (params: {
      index: number | null;
      rule: AdminPolicyRuleInput;
    }) =>
      saveAdminPolicyRule(auth.token, {
        agentId: activeAgentId,
        ...(params.index != null ? { index: params.index } : {}),
        rule: params.rule,
      }),
    onSuccess: (_payload, params) => {
      resetDraft();
      void queryClient.invalidateQueries({
        queryKey: ['admin-approvals', auth.token],
      });
      toast.success(
        params.index != null
          ? `Rule #${params.index} updated.`
          : 'Policy rule added.',
      );
    },
    onError: (error, params) => {
      toast.error(
        params.index != null ? 'Failed to update rule' : 'Failed to add rule',
        getErrorMessage(error),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (index: number) =>
      deleteAdminPolicyRule(auth.token, {
        agentId: activeAgentId,
        index,
      }),
    onSuccess: (_payload, index) => {
      if (editingRuleIndex === index) {
        resetDraft();
      }
      void queryClient.invalidateQueries({
        queryKey: ['admin-approvals', auth.token],
      });
      toast.success(`Rule #${index} deleted.`);
    },
    onError: (error, index) => {
      toast.error(`Failed to delete rule #${index}`, getErrorMessage(error));
    },
  });

  const presetMutation = useMutation({
    mutationFn: (presetName: string) =>
      saveAdminPolicyPreset(auth.token, {
        agentId: activeAgentId,
        presetName,
      }),
    onSuccess: (_payload, presetName) => {
      void queryClient.invalidateQueries({
        queryKey: ['admin-approvals', auth.token],
      });
      toast.success(`Template '${presetName}' applied.`);
    },
    onError: (error) => {
      toast.error('Failed to apply template', getErrorMessage(error));
    },
  });

  const defaultMutation = useMutation({
    mutationFn: (defaultAction: 'allow' | 'deny') =>
      saveAdminPolicyDefault(auth.token, {
        agentId: activeAgentId,
        defaultAction,
      }),
    onSuccess: (_payload, defaultAction) => {
      void queryClient.invalidateQueries({
        queryKey: ['admin-approvals', auth.token],
      });
      toast.success(`Default policy set to ${defaultAction}.`);
    },
    onError: (error) => {
      toast.error('Failed to update default policy', getErrorMessage(error));
    },
  });

  function handleDraftSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      saveMutation.mutate({
        index: editingRuleIndex,
        rule: buildPolicyRuleInput(draft),
      });
    } catch (error) {
      toast.error('Invalid policy rule', getErrorMessage(error));
    }
  }

  function beginEditRule(rule: AdminPolicyRule): void {
    setEditorMode('edit');
    setEditingRuleIndex(rule.index);
    setDraft(createPolicyRuleDraftFromRule(rule));
  }

  function beginDeleteRule(rule: AdminPolicyRule): void {
    setDeleteRuleTarget(rule);
  }

  const policyRules = approvalsQuery.data?.policy.rules || [];
  const availablePresetOptions = (approvalsQuery.data?.availablePresets || [])
    .filter(
      (preset) => !approvalsQuery.data?.policy.presets.includes(preset.name),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const policyMutationPending =
    saveMutation.isPending ||
    deleteMutation.isPending ||
    defaultMutation.isPending ||
    presetMutation.isPending;
  const editorOpen = editorMode !== null;
  const displayedDefaultAction =
    defaultMutation.isPending && defaultMutation.variables
      ? defaultMutation.variables
      : approvalsQuery.data?.policy.defaultAction || 'deny';

  useEffect(() => {
    setSelectedPresetName((current) => {
      if (
        current &&
        availablePresetOptions.some((preset) => preset.name === current)
      ) {
        return current;
      }
      return availablePresetOptions[0]?.name || '';
    });
  }, [availablePresetOptions]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Approvals & Policy"
        actions={
          <label className="field">
            <span>Policy agent</span>
            <select
              value={activeAgentId}
              disabled={approvalsQuery.isLoading && agents.length === 0}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              {agents.length ? (
                agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name ? `${agent.name} (${agent.id})` : agent.id}
                  </option>
                ))
              ) : (
                <option value={activeAgentId}>Loading agents...</option>
              )}
            </select>
          </label>
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Pending approvals"
          value={String(approvalsQuery.data?.pending.length || 0)}
        />
        <MetricCard
          label="Policy rules"
          value={String(policyRules.length || 0)}
        />
        <MetricCard
          label="Applied presets"
          value={String(approvalsQuery.data?.policy.presets.length || 0)}
        />
        <div className="metric-card">
          <span>Default policy</span>
          <div className="field">
            <select
              value={displayedDefaultAction}
              disabled={!approvalsQuery.data || policyMutationPending}
              onChange={(event) =>
                defaultMutation.mutate(
                  event.target.value === 'allow' ? 'allow' : 'deny',
                )
              }
            >
              <option value="deny">deny</option>
              <option value="allow">allow</option>
            </select>
          </div>
        </div>
      </div>

      <div className="page-stack">
        <Panel title="Policy" accent="warm">
          {approvalsQuery.isLoading ? (
            <div className="empty-state">Loading policy...</div>
          ) : approvalsQuery.data ? (
            <div className="detail-stack">
              {policyRules.length ? (
                <div className="table-shell">
                  <table className="policy-rules-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Action</th>
                        <th>Host</th>
                        <th>Port</th>
                        <th>Methods</th>
                        <th>Paths</th>
                        <th>Agent</th>
                        <th>Comment</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policyRules.map((rule) => (
                        <tr key={`${rule.index}:${rule.host}:${rule.agent}`}>
                          <td>{rule.index}</td>
                          <td>
                            <strong>{rule.action.toUpperCase()}</strong>
                          </td>
                          <td>{rule.host}</td>
                          <td>{String(rule.port)}</td>
                          <td>{rule.methods.join(', ')}</td>
                          <td>{rule.paths.join(', ')}</td>
                          <td>{rule.agent}</td>
                          <td>{formatRuleComment(rule)}</td>
                          <td>
                            <div className="policy-table-actions">
                              <button
                                className="ghost-button"
                                type="button"
                                disabled={policyMutationPending}
                                onClick={() => beginEditRule(rule)}
                              >
                                Edit
                              </button>
                              <button
                                className="danger-button"
                                type="button"
                                disabled={policyMutationPending}
                                onClick={() => beginDeleteRule(rule)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">No policy rules found.</div>
              )}

              <div className="policy-action-row">
                <button
                  className="primary-button"
                  type="button"
                  disabled={policyMutationPending}
                  onClick={beginCreateRule}
                >
                  New rule
                </button>
                <div className="policy-template-actions">
                  <label className="policy-template-inline">
                    <span>Template:</span>
                    <select
                      value={selectedPresetName}
                      disabled={
                        policyMutationPending ||
                        availablePresetOptions.length === 0
                      }
                      onChange={(event) =>
                        setSelectedPresetName(event.target.value)
                      }
                    >
                      {availablePresetOptions.length > 0 ? (
                        availablePresetOptions.map((preset) => (
                          <option key={preset.name} value={preset.name}>
                            {preset.name}
                          </option>
                        ))
                      ) : (
                        <option value="">No templates available</option>
                      )}
                    </select>
                  </label>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={policyMutationPending || !selectedPresetName}
                    onClick={() => presetMutation.mutate(selectedPresetName)}
                  >
                    Add template
                  </button>
                </div>
              </div>

              {editorOpen ? (
                <form
                  className="config-section detail-stack"
                  onSubmit={handleDraftSubmit}
                >
                  <strong>
                    {editorMode === 'edit' && editingRuleIndex != null
                      ? `Edit rule #${editingRuleIndex}`
                      : 'Add rule'}
                  </strong>

                  <div className="field-grid policy-editor-grid">
                    <label className="field">
                      <span>Action</span>
                      <select
                        value={draft.action}
                        disabled={policyMutationPending}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            action:
                              event.target.value === 'deny' ? 'deny' : 'allow',
                          }))
                        }
                      >
                        <option value="allow">allow</option>
                        <option value="deny">deny</option>
                      </select>
                    </label>

                    <label className="field">
                      <span>Host</span>
                      <input
                        value={draft.host}
                        disabled={policyMutationPending}
                        placeholder="example.com"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            host: event.target.value,
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Port</span>
                      <input
                        value={draft.port}
                        disabled={policyMutationPending}
                        placeholder="*"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            port: event.target.value,
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Methods</span>
                      <input
                        value={draft.methods}
                        disabled={policyMutationPending}
                        placeholder="*"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            methods: event.target.value,
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Paths</span>
                      <input
                        value={draft.paths}
                        disabled={policyMutationPending}
                        placeholder="/**"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            paths: event.target.value,
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Agent</span>
                      <input
                        value={draft.agent}
                        disabled={policyMutationPending}
                        placeholder="*"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            agent: event.target.value,
                          }))
                        }
                      />
                    </label>

                    <label className="field policy-comment-field">
                      <span>Comment</span>
                      <textarea
                        rows={2}
                        value={draft.comment}
                        disabled={policyMutationPending}
                        placeholder="Optional note"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            comment: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="button-row">
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={policyMutationPending}
                    >
                      {saveMutation.isPending ? (
                        <span className="button-with-spinner">
                          <span aria-hidden="true" className="button-spinner" />
                          {editorMode === 'edit' ? 'Saving...' : 'Adding...'}
                        </span>
                      ) : editorMode === 'edit' ? (
                        'Save changes'
                      ) : (
                        'Save'
                      )}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={policyMutationPending}
                      onClick={resetDraft}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">Policy state is unavailable.</div>
          )}
        </Panel>

        <Panel title="Pending approvals">
          {approvalsQuery.isLoading ? (
            <div className="empty-state">Loading pending approvals...</div>
          ) : approvalsQuery.data?.pending.length ? (
            <div className="list-stack">
              {approvalsQuery.data.pending.map((approval) => (
                <div className="summary-block" key={approval.approvalId}>
                  <div className="key-value-grid">
                    <div>
                      <span>Approval</span>
                      <strong>
                        {approval.actionKey || approval.approvalId}
                      </strong>
                    </div>
                    <div>
                      <span>Agent</span>
                      <strong>{approval.agentId || 'unknown'}</strong>
                    </div>
                    <div>
                      <span>Session</span>
                      <strong>{approval.sessionId}</strong>
                    </div>
                    <div>
                      <span>Trust scopes</span>
                      <strong>
                        {formatPendingTrustScopes({
                          allowSession: approval.allowSession,
                          allowAgent: approval.allowAgent,
                          allowAll: approval.allowAll,
                        })}
                      </strong>
                    </div>
                    <div>
                      <span>Created</span>
                      <strong title={formatDateTime(approval.createdAt)}>
                        {formatRelativeTime(approval.createdAt)}
                      </strong>
                    </div>
                    <div>
                      <span>Expires</span>
                      <strong title={formatDateTime(approval.expiresAt)}>
                        {formatRelativeTime(approval.expiresAt)}
                      </strong>
                    </div>
                  </div>
                  <p className="supporting-text">{approval.prompt}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No pending approvals right now.</div>
          )}
        </Panel>
      </div>
      <Dialog
        open={deleteRuleTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteRuleTarget(null);
          }
        }}
      >
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Delete policy rule?</DialogTitle>
            <DialogDescription>
              {deleteRuleTarget
                ? `This will remove rule #${deleteRuleTarget.index} for ${deleteRuleTarget.host}.`
                : 'This will remove the selected policy rule.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="ghost-button">Cancel</DialogClose>
            <DialogClose
              className="danger-button"
              onClick={() => {
                if (deleteRuleTarget) {
                  deleteMutation.mutate(deleteRuleTarget.index);
                }
              }}
            >
              Delete
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
