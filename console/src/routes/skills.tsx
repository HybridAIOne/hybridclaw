import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import {
  applyAdaptiveSkillAmendment,
  createSkill,
  fetchAdaptiveSkillAmendmentHistory,
  fetchAdaptiveSkillAmendments,
  fetchAdaptiveSkillHealth,
  fetchSkills,
  rejectAdaptiveSkillAmendment,
  saveSkillEnabled,
  uploadSkillZip,
} from '../api/client';
import type {
  AdminAdaptiveSkillAmendment,
  AdminAdaptiveSkillHealthMetric,
} from '../api/types';
import { useAuth } from '../auth';
import {
  BooleanField,
  BooleanPill,
  BooleanToggle,
  MetricCard,
  PageHeader,
  Panel,
} from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatFeedbackCounts(metrics: AdminAdaptiveSkillHealthMetric): string {
  return `+${metrics.positive_feedback_count} / -${metrics.negative_feedback_count}`;
}

function formatAmendmentStatus(amendment: AdminAdaptiveSkillAmendment): string {
  return `${amendment.status} · v${amendment.version}`;
}

function formatAmendmentTiming(amendment: AdminAdaptiveSkillAmendment): string {
  const relevantTimestamp =
    amendment.applied_at ||
    amendment.rejected_at ||
    amendment.rolled_back_at ||
    amendment.updated_at ||
    amendment.created_at;
  return formatRelativeTime(relevantTimestamp);
}

interface SkillFileDraft {
  id: number;
  path: string;
  content: string;
}

let nextFileId = 1;

interface SkillDraft {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  tags: string;
  body: string;
  files: SkillFileDraft[];
}

function createEmptyDraft(): SkillDraft {
  return {
    name: '',
    description: '',
    userInvocable: true,
    disableModelInvocation: false,
    tags: '',
    body: '',
    files: [],
  };
}

export function SkillsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [selectedSkillName, setSelectedSkillName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<'form' | 'zip'>('form');
  const [draft, setDraft] = useState<SkillDraft>(createEmptyDraft());
  const [zipFile, setZipFile] = useState<File | null>(null);
  const deferredFilter = useDeferredValue(filter);
  const filterNeedle = deferredFilter.trim().toLowerCase();

  const skillsQuery = useQuery({
    queryKey: ['skills', auth.token],
    queryFn: () => fetchSkills(auth.token),
  });

  const healthQuery = useQuery({
    queryKey: ['adaptive-skills-health', auth.token],
    queryFn: () => fetchAdaptiveSkillHealth(auth.token),
  });

  const stagedAmendmentsQuery = useQuery({
    queryKey: ['adaptive-skills-amendments', auth.token],
    queryFn: () => fetchAdaptiveSkillAmendments(auth.token),
  });

  const toggleMutation = useMutation({
    mutationFn: (payload: { name: string; enabled: boolean }) =>
      saveSkillEnabled(auth.token, payload),
    onSuccess: (payload) => {
      queryClient.setQueryData(['skills', auth.token], payload);
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async (payload: {
      action: 'apply' | 'reject';
      skillName: string;
    }) =>
      payload.action === 'apply'
        ? applyAdaptiveSkillAmendment(auth.token, payload.skillName)
        : rejectAdaptiveSkillAmendment(auth.token, payload.skillName),
    onSuccess: async (_payload, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['adaptive-skills-health', auth.token],
        }),
        queryClient.invalidateQueries({
          queryKey: ['adaptive-skills-amendments', auth.token],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            'adaptive-skills-history',
            auth.token,
            variables.skillName,
          ],
        }),
      ]);
    },
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const tags = draft.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const files = draft.files
        .filter((f) => f.path.trim())
        .map((f) => ({ path: f.path.trim(), content: f.content }));
      return createSkill(auth.token, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        userInvocable: draft.userInvocable,
        disableModelInvocation: draft.disableModelInvocation,
        tags: tags.length > 0 ? tags : undefined,
        body: draft.body.trim(),
        files: files.length > 0 ? files : undefined,
      });
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['skills', auth.token], payload);
      setShowCreate(false);
      setDraft(createEmptyDraft());
    },
  });

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (!zipFile) throw new Error('No file selected.');
      return uploadSkillZip(auth.token, zipFile);
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['skills', auth.token], payload);
      setShowCreate(false);
      setZipFile(null);
    },
  });

  const healthMetrics = healthQuery.data?.metrics || [];
  const stagedAmendments = stagedAmendmentsQuery.data?.amendments || [];
  const knownSkillNames = new Set([
    ...(skillsQuery.data?.skills || []).map((skill) => skill.name),
    ...healthMetrics.map((metrics) => metrics.skill_name),
    ...stagedAmendments.map((amendment) => amendment.skill_name),
  ]);
  const effectiveSelectedSkillName =
    selectedSkillName && knownSkillNames.has(selectedSkillName)
      ? selectedSkillName
      : stagedAmendments[0]?.skill_name ||
        healthMetrics[0]?.skill_name ||
        skillsQuery.data?.skills[0]?.name ||
        '';

  const historyQuery = useQuery({
    queryKey: [
      'adaptive-skills-history',
      auth.token,
      effectiveSelectedSkillName,
    ],
    queryFn: () =>
      fetchAdaptiveSkillAmendmentHistory(
        auth.token,
        effectiveSelectedSkillName,
      ),
    enabled: Boolean(effectiveSelectedSkillName),
  });

  const filteredSkills = (skillsQuery.data?.skills || []).filter((skill) => {
    const haystack = [
      skill.name,
      skill.category,
      skill.description,
      skill.source,
      ...(skill.tags || []),
      ...(skill.relatedSkills || []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(filterNeedle);
  });

  const filteredHealthMetrics = healthMetrics.filter((metrics) => {
    const haystack = [
      metrics.skill_name,
      ...metrics.degradation_reasons,
      ...metrics.error_clusters.map((cluster) => cluster.category),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(filterNeedle);
  });

  const degradedSkillCount = healthMetrics.filter(
    (metrics) => metrics.degraded,
  ).length;
  const selectedMetrics = healthMetrics.find(
    (metrics) => metrics.skill_name === effectiveSelectedSkillName,
  );
  const historyEntries = historyQuery.data?.amendments || [];

  return (
    <div className="page-stack">
      <PageHeader
        title="Skills"
        description="Discovery, runtime availability, and AdaptiveSkills health and amendment review."
        actions={
          <>
            <input
              className="compact-search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter skills"
            />
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                setShowCreate(!showCreate);
                setDraft(createEmptyDraft());
                setZipFile(null);
                setCreateMode('form');
                createMutation.reset();
                uploadMutation.reset();
              }}
            >
              {showCreate ? 'Cancel' : 'New skill'}
            </button>
          </>
        }
      />

      {showCreate ? (
        <Panel title="Create skill" accent="warm">
          <fieldset className="binary-toggle" aria-label="Create mode">
            <button
              className={
                createMode === 'form'
                  ? 'binary-toggle-button active is-on'
                  : 'binary-toggle-button'
              }
              type="button"
              onClick={() => setCreateMode('form')}
            >
              Form
            </button>
            <button
              className={
                createMode === 'zip'
                  ? 'binary-toggle-button active is-on'
                  : 'binary-toggle-button'
              }
              type="button"
              onClick={() => setCreateMode('zip')}
            >
              Upload ZIP
            </button>
          </fieldset>

          {createMode === 'zip' ? (
            <div className="stack-form">
              <label className="field">
                <span>Skill archive (.zip)</span>
                <input
                  type="file"
                  accept=".zip,.skill"
                  onChange={(event) =>
                    setZipFile(event.target.files?.[0] || null)
                  }
                />
              </label>
              <p className="supporting-text">
                ZIP must contain a SKILL.md with a valid <code>name</code>{' '}
                frontmatter field. May include scripts/, references/, and other
                files.
              </p>
              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  disabled={uploadMutation.isPending || !zipFile}
                  onClick={() => uploadMutation.mutate()}
                >
                  {uploadMutation.isPending ? 'Uploading...' : 'Upload skill'}
                </button>
              </div>
              {uploadMutation.isError ? (
                <p className="error-banner">
                  {(uploadMutation.error as Error).message}
                </p>
              ) : null}
              {uploadMutation.isSuccess ? (
                <p className="success-banner">Skill uploaded successfully.</p>
              ) : null}
            </div>
          ) : (
            <div className="stack-form">
              <div className="field-grid">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="my-skill"
                  />
                </label>
                <label className="field">
                  <span>Tags</span>
                  <input
                    value={draft.tags}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        tags: event.target.value,
                      }))
                    }
                    placeholder="tag1, tag2"
                  />
                </label>
              </div>

              <label className="field">
                <span>Description</span>
                <input
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  placeholder="Short description of what this skill does"
                />
              </label>

              <div className="field-grid">
                <BooleanField
                  label="User invocable"
                  value={draft.userInvocable}
                  trueLabel="yes"
                  falseLabel="no"
                  onChange={(userInvocable) =>
                    setDraft((current) => ({ ...current, userInvocable }))
                  }
                />
                <BooleanField
                  label="Disable model invocation"
                  value={draft.disableModelInvocation}
                  trueLabel="yes"
                  falseLabel="no"
                  onChange={(disableModelInvocation) =>
                    setDraft((current) => ({
                      ...current,
                      disableModelInvocation,
                    }))
                  }
                />
              </div>

              <label className="field">
                <span>Skill body (Markdown)</span>
                <textarea
                  rows={10}
                  value={draft.body}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      body: event.target.value,
                    }))
                  }
                  placeholder={
                    '# My Skill\n\nUse this skill when the user asks to ...\n\n## Workflow\n\n1. ...\n2. ...'
                  }
                />
              </label>

              <div className="panel-header" style={{ marginTop: '0.5rem' }}>
                <div>
                  <h4>Files</h4>
                  <p className="supporting-text">
                    Add scripts or references (e.g. scripts/run.mjs,
                    references/guide.md)
                  </p>
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      files: [
                        ...current.files,
                        { id: nextFileId++, path: 'scripts/new-file.mjs', content: '' },
                      ],
                    }))
                  }
                >
                  Add file
                </button>
              </div>

              {draft.files.map((file, index) => (
                <div
                  key={file.id}
                  className="stack-form"
                  style={{ gap: '0.25rem' }}
                >
                  <div className="field-grid">
                    <label className="field">
                      <span>Path</span>
                      <input
                        value={file.path}
                        onChange={(event) =>
                          setDraft((current) => {
                            const files = [...current.files];
                            files[index] = {
                              ...files[index],
                              path: event.target.value,
                            };
                            return { ...current, files };
                          })
                        }
                        placeholder="scripts/my-tool.mjs"
                      />
                    </label>
                    <button
                      className="danger-button"
                      type="button"
                      style={{ alignSelf: 'end' }}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          files: current.files.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <label className="field">
                    <span>Content</span>
                    <textarea
                      rows={8}
                      value={file.content}
                      onChange={(event) =>
                        setDraft((current) => {
                          const files = [...current.files];
                          files[index] = {
                            ...files[index],
                            content: event.target.value,
                          };
                          return { ...current, files };
                        })
                      }
                      placeholder="// Script content..."
                      style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                    />
                  </label>
                </div>
              ))}

              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    createMutation.isPending ||
                    !draft.name.trim() ||
                    !draft.description.trim()
                  }
                  onClick={() => createMutation.mutate()}
                >
                  {createMutation.isPending ? 'Creating...' : 'Create skill'}
                </button>
              </div>

              {createMutation.isError ? (
                <p className="error-banner">
                  {(createMutation.error as Error).message}
                </p>
              ) : null}
              {createMutation.isSuccess ? (
                <p className="success-banner">
                  Skill {draft.name.trim() || 'created'} successfully.
                </p>
              ) : null}
            </div>
          )}
        </Panel>
      ) : null}

      <div className="metric-grid">
        <MetricCard
          label="Installed skills"
          value={String(skillsQuery.data?.skills.length || 0)}
          detail={`${skillsQuery.data?.disabled.length || 0} disabled`}
        />
        <MetricCard
          label="Observed skills"
          value={String(healthMetrics.length)}
          detail="from AdaptiveSkills observations"
        />
        <MetricCard
          label="Degraded skills"
          value={String(degradedSkillCount)}
          detail="current inspection window"
        />
        <MetricCard
          label="Staged amendments"
          value={String(stagedAmendments.length)}
          detail="awaiting human review"
        />
      </div>

      <div className="two-column-grid">
        <Panel title="Discovery">
          <div className="key-value-grid">
            <div>
              <span>Extra dirs</span>
              <strong>
                {skillsQuery.data?.extraDirs.length
                  ? skillsQuery.data.extraDirs.join(', ')
                  : 'none'}
              </strong>
            </div>
            <div>
              <span>Disabled skills</span>
              <strong>
                {skillsQuery.data?.disabled.length
                  ? skillsQuery.data.disabled.join(', ')
                  : 'none'}
              </strong>
            </div>
          </div>
        </Panel>

        <Panel
          title="AdaptiveSkills"
          subtitle={
            selectedMetrics
              ? `${selectedMetrics.skill_name} selected for history review`
              : 'Select a skill to review amendment history'
          }
          accent="warm"
        >
          {selectedMetrics ? (
            <div className="key-value-grid">
              <div>
                <span>Status</span>
                <strong>
                  {selectedMetrics.degraded ? 'degraded' : 'healthy'}
                </strong>
              </div>
              <div>
                <span>Executions</span>
                <strong>{selectedMetrics.total_executions}</strong>
              </div>
              <div>
                <span>Success rate</span>
                <strong>{formatPercent(selectedMetrics.success_rate)}</strong>
              </div>
              <div>
                <span>Feedback</span>
                <strong>{formatFeedbackCounts(selectedMetrics)}</strong>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              No AdaptiveSkills observations are available yet.
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Installed skills"
        subtitle={`${filteredSkills.length} skill${filteredSkills.length === 1 ? '' : 's'} visible`}
      >
        {skillsQuery.isLoading ? (
          <div className="empty-state">Loading skill catalog...</div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Category</th>
                  <th>Source</th>
                  <th>Runtime</th>
                  <th>Adaptive</th>
                  <th>Tags</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredSkills.map((skill) => {
                  const metrics = healthMetrics.find(
                    (entry) => entry.skill_name === skill.name,
                  );
                  return (
                    <tr key={skill.name}>
                      <td>
                        <button
                          type="button"
                          className="table-link-button"
                          onClick={() => setSelectedSkillName(skill.name)}
                        >
                          {skill.name}
                        </button>
                        <small>{skill.description}</small>
                      </td>
                      <td>{skill.category}</td>
                      <td>{skill.source}</td>
                      <td>
                        <BooleanPill
                          value={skill.available}
                          trueLabel="ready"
                          falseLabel="missing"
                        />
                        {!skill.available ? (
                          <small>
                            {skill.missing.join(', ') || 'missing requirements'}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {metrics ? (
                          <>
                            <BooleanPill
                              value={!metrics.degraded}
                              trueLabel="healthy"
                              falseLabel="degraded"
                            />
                            <small>
                              {metrics.total_executions} runs ·{' '}
                              {formatFeedbackCounts(metrics)}
                            </small>
                          </>
                        ) : (
                          <small>no observations</small>
                        )}
                      </td>
                      <td>{skill.tags.join(', ') || 'none'}</td>
                      <td>
                        <BooleanToggle
                          value={skill.enabled}
                          ariaLabel={`${skill.name} status`}
                          disabled={toggleMutation.isPending}
                          trueLabel="active"
                          falseLabel="inactive"
                          onChange={(enabled) =>
                            toggleMutation.mutate({
                              name: skill.name,
                              enabled,
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
                {filteredSkills.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        No skills match this filter.
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {toggleMutation.isError ? (
          <p className="error-banner">
            {(toggleMutation.error as Error).message}
          </p>
        ) : null}
      </Panel>

      <div className="two-column-grid">
        <Panel
          title="Observed skill health"
          subtitle={`${filteredHealthMetrics.length} observed skill${filteredHealthMetrics.length === 1 ? '' : 's'} visible`}
        >
          {healthQuery.isLoading ? (
            <div className="empty-state">Loading AdaptiveSkills health...</div>
          ) : filteredHealthMetrics.length === 0 ? (
            <div className="empty-state">
              No observed skills match this filter.
            </div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Status</th>
                    <th>Executions</th>
                    <th>Success</th>
                    <th>Tool breakage</th>
                    <th>Feedback</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHealthMetrics.map((metrics) => (
                    <tr key={metrics.skill_name}>
                      <td>
                        <button
                          type="button"
                          className="table-link-button"
                          onClick={() =>
                            setSelectedSkillName(metrics.skill_name)
                          }
                        >
                          {metrics.skill_name}
                        </button>
                        <small>
                          Window ending{' '}
                          {formatDateTime(metrics.window_ended_at)}
                        </small>
                      </td>
                      <td>
                        <BooleanPill
                          value={!metrics.degraded}
                          trueLabel="healthy"
                          falseLabel="degraded"
                        />
                      </td>
                      <td>{metrics.total_executions}</td>
                      <td>{formatPercent(metrics.success_rate)}</td>
                      <td>{formatPercent(metrics.tool_breakage_rate)}</td>
                      <td>{formatFeedbackCounts(metrics)}</td>
                      <td>
                        <small>
                          {metrics.degradation_reasons.join('; ') || 'healthy'}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Staged amendments"
          subtitle={`${stagedAmendments.length} waiting for review`}
          accent="warm"
        >
          {stagedAmendmentsQuery.isLoading ? (
            <div className="empty-state">Loading staged amendments...</div>
          ) : stagedAmendments.length === 0 ? (
            <div className="empty-state">
              No staged amendments are waiting for review.
            </div>
          ) : (
            <div className="list-stack selectable-list">
              {stagedAmendments.map((amendment) => (
                <div className="list-row" key={amendment.id}>
                  <div>
                    <button
                      type="button"
                      className="table-link-button"
                      onClick={() => setSelectedSkillName(amendment.skill_name)}
                    >
                      {amendment.skill_name}
                    </button>
                    <small>
                      {formatAmendmentStatus(amendment)} ·{' '}
                      {formatAmendmentTiming(amendment)} · guard{' '}
                      {amendment.guard_verdict}/{amendment.guard_findings_count}
                    </small>
                    <small>
                      {amendment.rationale || amendment.diff_summary}
                    </small>
                  </div>
                  <div className="skill-review-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setSelectedSkillName(amendment.skill_name)}
                    >
                      History
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        reviewMutation.mutate({
                          action: 'apply',
                          skillName: amendment.skill_name,
                        })
                      }
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        reviewMutation.mutate({
                          action: 'reject',
                          skillName: amendment.skill_name,
                        })
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {reviewMutation.isError ? (
            <p className="error-banner">
              {(reviewMutation.error as Error).message}
            </p>
          ) : null}
        </Panel>
      </div>

      <Panel
        title={
          effectiveSelectedSkillName
            ? `Amendment history: ${effectiveSelectedSkillName}`
            : 'Amendment history'
        }
        subtitle="Full review trail for the selected skill"
      >
        {!effectiveSelectedSkillName ? (
          <div className="empty-state">
            Select a skill to inspect its amendment history.
          </div>
        ) : historyQuery.isLoading ? (
          <div className="empty-state">Loading amendment history...</div>
        ) : historyEntries.length === 0 ? (
          <div className="empty-state">
            No amendment history exists for this skill yet.
          </div>
        ) : (
          <div className="list-stack selectable-list">
            {historyEntries.map((amendment) => (
              <div className="list-row" key={amendment.id}>
                <div>
                  <strong>
                    {formatAmendmentStatus(amendment)} ·{' '}
                    {formatAmendmentTiming(amendment)}
                  </strong>
                  <small>
                    Guard {amendment.guard_verdict}/
                    {amendment.guard_findings_count} · runs since apply{' '}
                    {amendment.runs_since_apply}
                  </small>
                  <small>
                    {amendment.rationale || 'No rationale recorded.'}
                  </small>
                  <small>
                    {amendment.diff_summary || 'No diff summary recorded.'}
                  </small>
                </div>
                <span
                  className={
                    amendment.status === 'applied'
                      ? 'list-status list-status-success'
                      : amendment.status === 'rejected'
                        ? 'list-status list-status-danger'
                        : 'list-status'
                  }
                >
                  {amendment.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
