import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  fetchAdminAgentMarkdownFile,
  fetchAdminAgentMarkdownRevision,
  fetchAdminAgents,
  restoreAdminAgentMarkdownRevision,
  saveAdminAgentMarkdownFile,
} from '../api/client';
import type { AdminAgent } from '../api/types';
import { useAuth } from '../auth';
import { useToast } from '../components/toast';
import { Panel } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function getDefaultFileName(agent: AdminAgent | null): string | null {
  if (!agent) return null;
  return (
    agent.markdownFiles.find((file) => file.exists)?.name ||
    agent.markdownFiles[0]?.name ||
    null
  );
}

function getSelectedDocumentKey(
  agentId: string | null | undefined,
  fileName: string | null | undefined,
): string | null {
  if (!agentId || !fileName) return null;
  return `${agentId}:${fileName}`;
}

export function AgentFilesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    null,
  );
  const [draftContent, setDraftContent] = useState('');
  const hydratedDocumentKeyRef = useRef<string | null>(null);
  const hydratedContentRef = useRef('');

  const agentsQuery = useQuery({
    queryKey: ['admin-agents', auth.token],
    queryFn: () => fetchAdminAgents(auth.token),
  });

  const selectedAgent =
    agentsQuery.data?.find((agent) => agent.id === selectedAgentId) ||
    agentsQuery.data?.[0] ||
    null;

  useEffect(() => {
    if (selectedAgent && selectedAgent.id !== selectedAgentId) {
      setSelectedAgentId(selectedAgent.id);
    }
  }, [selectedAgent, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgent) {
      if (selectedFileName !== null) {
        setSelectedFileName(null);
        setSelectedRevisionId(null);
      }
      return;
    }
    const availableFile =
      selectedAgent.markdownFiles.find((file) => file.name === selectedFileName)
        ?.name || getDefaultFileName(selectedAgent);
    if (availableFile !== selectedFileName) {
      setSelectedFileName(availableFile);
      setSelectedRevisionId(null);
    }
  }, [selectedAgent, selectedFileName]);

  const selectedFileSummary =
    selectedAgent?.markdownFiles.find(
      (file) => file.name === selectedFileName,
    ) || null;
  const selectedDocumentKey = getSelectedDocumentKey(
    selectedAgent?.id,
    selectedFileName,
  );
  const selectedFileQueryKey = [
    'admin-agent-markdown',
    auth.token,
    selectedAgent?.id || '',
    selectedFileName || '',
  ] as const;

  const fileQuery = useQuery({
    queryKey: selectedFileQueryKey,
    queryFn: () =>
      fetchAdminAgentMarkdownFile(auth.token, {
        agentId: selectedAgent?.id || '',
        fileName: selectedFileName || '',
      }),
    enabled: Boolean(selectedAgent?.id && selectedFileName),
    refetchOnWindowFocus: false,
  });
  const selectedFileMetadata =
    fileQuery.data?.file.name === selectedFileName
      ? fileQuery.data.file
      : selectedFileSummary;

  const revisionQuery = useQuery({
    queryKey: [
      'admin-agent-markdown-revision',
      auth.token,
      selectedAgent?.id || '',
      selectedFileName || '',
      selectedRevisionId || '',
    ],
    queryFn: () =>
      fetchAdminAgentMarkdownRevision(auth.token, {
        agentId: selectedAgent?.id || '',
        fileName: selectedFileName || '',
        revisionId: selectedRevisionId || '',
      }),
    enabled: Boolean(
      selectedAgent?.id && selectedFileName && selectedRevisionId,
    ),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!selectedDocumentKey) {
      hydratedDocumentKeyRef.current = null;
      hydratedContentRef.current = '';
      setDraftContent('');
      return;
    }
    if (!fileQuery.data) return;
    const nextContent = fileQuery.data.file.content;
    const shouldHydrateDraft =
      hydratedDocumentKeyRef.current !== selectedDocumentKey ||
      draftContent === hydratedContentRef.current;
    if (!shouldHydrateDraft) return;
    hydratedDocumentKeyRef.current = selectedDocumentKey;
    hydratedContentRef.current = nextContent;
    setDraftContent(nextContent);
  }, [draftContent, fileQuery.data, selectedDocumentKey]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAgent || !selectedFileName) {
        throw new Error('Select an agent and markdown file first.');
      }
      return saveAdminAgentMarkdownFile(auth.token, {
        agentId: selectedAgent.id,
        fileName: selectedFileName,
        content: draftContent,
      });
    },
    onSuccess: (payload) => {
      const nextDocumentKey = getSelectedDocumentKey(
        payload.agent.id,
        payload.file.name,
      );
      queryClient.setQueryData(
        [
          'admin-agent-markdown',
          auth.token,
          payload.agent.id,
          payload.file.name,
        ],
        payload,
      );
      void queryClient.invalidateQueries({
        queryKey: ['admin-agents', auth.token],
      });
      hydratedDocumentKeyRef.current = nextDocumentKey;
      hydratedContentRef.current = payload.file.content;
      setDraftContent(payload.file.content);
      toast.success(
        `Saved ${payload.file.name} for ${payload.agent.name || payload.agent.id}.`,
      );
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAgent || !selectedFileName || !selectedRevisionId) {
        throw new Error('Select a version to restore first.');
      }
      return restoreAdminAgentMarkdownRevision(auth.token, {
        agentId: selectedAgent.id,
        fileName: selectedFileName,
        revisionId: selectedRevisionId,
      });
    },
    onSuccess: (payload) => {
      const nextDocumentKey = getSelectedDocumentKey(
        payload.agent.id,
        payload.file.name,
      );
      queryClient.setQueryData(
        [
          'admin-agent-markdown',
          auth.token,
          payload.agent.id,
          payload.file.name,
        ],
        payload,
      );
      void queryClient.invalidateQueries({
        queryKey: ['admin-agents', auth.token],
      });
      hydratedDocumentKeyRef.current = nextDocumentKey;
      hydratedContentRef.current = payload.file.content;
      setDraftContent(payload.file.content);
      toast.success(`Restored ${payload.file.name} from version history.`);
    },
    onError: (error) => {
      toast.error('Restore failed', getErrorMessage(error));
    },
  });

  const isDirty = fileQuery.data
    ? draftContent !== fileQuery.data.file.content
    : false;

  return (
    <div className="page-stack">
      <Panel accent="warm">
        {agentsQuery.isLoading ? (
          <div className="empty-state">Loading agents...</div>
        ) : !agentsQuery.data?.length ? (
          <div className="empty-state">No agents are registered yet.</div>
        ) : !selectedAgent ? (
          <div className="empty-state">Select an agent to edit its files.</div>
        ) : !selectedFileName ? (
          <div className="empty-state">
            This agent does not expose editable markdown files.
          </div>
        ) : (
          <div className="detail-stack">
            <div className="field-grid">
              <label className="field">
                <span>Agent</span>
                <select
                  value={selectedAgent.id}
                  onChange={(event) => {
                    setSelectedAgentId(event.target.value);
                    setSelectedRevisionId(null);
                  }}
                >
                  {agentsQuery.data.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name || agent.id}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Markdown file</span>
                <select
                  value={selectedFileName}
                  onChange={(event) => {
                    setSelectedFileName(event.target.value);
                    setSelectedRevisionId(null);
                  }}
                >
                  {selectedAgent.markdownFiles.map((file) => (
                    <option key={file.name} value={file.name}>
                      {file.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {selectedFileSummary ? (
              <div className="agent-file-meta">
                <p className="supporting-text agent-file-meta-line">
                  {selectedFileMetadata?.exists
                    ? selectedFileMetadata.updatedAt
                      ? `Last updated ${formatRelativeTime(selectedFileMetadata.updatedAt)} · ${formatDateTime(selectedFileMetadata.updatedAt)} · ${selectedFileMetadata.path}`
                      : selectedFileMetadata.path
                    : 'File not created yet'}
                </p>
              </div>
            ) : null}

            {fileQuery.isLoading ? (
              <div className="empty-state">Loading markdown file...</div>
            ) : (
              <>
                <label className="field textarea-field">
                  <span className="agent-file-editor-title">
                    {selectedFileName}
                  </span>
                  <textarea
                    className="code-editor"
                    rows={28}
                    value={draftContent}
                    onChange={(event) => setDraftContent(event.target.value)}
                  />
                </label>

                <div className="button-row">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      saveMutation.isPending || !fileQuery.data || !isDirty
                    }
                    onClick={() => saveMutation.mutate()}
                  >
                    {saveMutation.isPending ? 'Saving...' : 'Save Markdown'}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={
                      !fileQuery.data || saveMutation.isPending || !isDirty
                    }
                    onClick={() => {
                      const nextContent = fileQuery.data?.file.content || '';
                      if (selectedDocumentKey) {
                        hydratedDocumentKeyRef.current = selectedDocumentKey;
                      }
                      hydratedContentRef.current = nextContent;
                      setDraftContent(nextContent);
                    }}
                  >
                    Reset to Disk
                  </button>
                  <p className="supporting-text">
                    {isDirty
                      ? 'Unsaved changes.'
                      : selectedFileSummary?.exists
                        ? 'Disk copy loaded.'
                        : 'Saving will create this file in the agent workspace.'}
                  </p>
                </div>

                <div className="two-column-grid">
                  <Panel
                    title="Versions"
                    subtitle={`${fileQuery.data?.file.revisions.length || 0} saved revision${fileQuery.data?.file.revisions.length === 1 ? '' : 's'}`}
                  >
                    {!fileQuery.data?.file.revisions.length ? (
                      <div className="empty-state">
                        Revisions appear here after the file changes.
                      </div>
                    ) : (
                      <div className="list-stack selectable-list">
                        {fileQuery.data.file.revisions.map((revision) => (
                          <button
                            key={revision.id}
                            className={
                              revision.id === selectedRevisionId
                                ? 'selectable-row active'
                                : 'selectable-row'
                            }
                            type="button"
                            onClick={() => setSelectedRevisionId(revision.id)}
                          >
                            <div>
                              <strong>
                                {formatDateTime(revision.createdAt)}
                              </strong>
                              <small>
                                {formatRelativeTime(revision.createdAt)} ·{' '}
                                {revision.source} · {revision.sizeBytes} bytes
                              </small>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </Panel>

                  <Panel title="Version Preview" accent="warm">
                    {!selectedRevisionId ? (
                      <div className="empty-state">
                        Select a saved version to preview or restore it.
                      </div>
                    ) : revisionQuery.isLoading ? (
                      <div className="empty-state">Loading version...</div>
                    ) : !revisionQuery.data ? (
                      <div className="empty-state">
                        Version details are unavailable.
                      </div>
                    ) : (
                      <div className="detail-stack">
                        <div className="summary-block">
                          <span>
                            {formatDateTime(
                              revisionQuery.data.revision.createdAt,
                            )}
                          </span>
                          <p>
                            {revisionQuery.data.revision.sha256.slice(0, 16)} ·{' '}
                            {revisionQuery.data.revision.source}
                          </p>
                        </div>
                        <label className="field textarea-field">
                          <span>Saved content</span>
                          <textarea
                            className="code-editor"
                            rows={14}
                            readOnly
                            value={revisionQuery.data.revision.content}
                          />
                        </label>
                        <div className="button-row">
                          <button
                            className="primary-button"
                            type="button"
                            disabled={restoreMutation.isPending}
                            onClick={() => restoreMutation.mutate()}
                          >
                            {restoreMutation.isPending
                              ? 'Restoring...'
                              : 'Restore Version'}
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() =>
                              setDraftContent(
                                revisionQuery.data?.revision.content || '',
                              )
                            }
                          >
                            Copy to Editor
                          </button>
                        </div>
                      </div>
                    )}
                  </Panel>
                </div>
              </>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
