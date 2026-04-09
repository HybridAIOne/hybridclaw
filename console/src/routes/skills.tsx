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
  AdminSkill,
} from '../api/types';
import { useAuth } from '../auth';
import {
  BooleanField,
  BooleanPill,
  BooleanToggle,
  MetricCard,
  PageHeader,
  Panel,
  SegmentedToggle,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { compareBoolean, compareNumber, compareText } from '../lib/sort';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const DEFAULT_SKILL_CATEGORIES = [
  'agents',
  'apple',
  'business',
  'communication',
  'development',
  'memory',
  'misc',
  'office',
  'productivity',
  'publishing',
  'security',
  'uncategorized',
];

function formatFeedbackCounts(
  metrics: AdminAdaptiveSkillHealthMetric,
): string | null {
  if (
    metrics.positive_feedback_count === 0 &&
    metrics.negative_feedback_count === 0
  ) {
    return null;
  }
  return `👍 ${metrics.positive_feedback_count} · 👎 ${metrics.negative_feedback_count}`;
}

function abbreviateDescription(value: string, maxChars = 120): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const truncated = normalized.slice(0, maxChars - 1);
  const boundary = truncated.lastIndexOf(' ');
  const head =
    boundary >= Math.floor(maxChars * 0.6)
      ? truncated.slice(0, boundary)
      : truncated;
  return `${head.trimEnd()}…`;
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

interface InstalledSkillRow {
  skill: AdminSkill;
  metrics: AdminAdaptiveSkillHealthMetric | null;
}

type InstalledSkillSortKey =
  | 'skill'
  | 'category'
  | 'source'
  | 'health'
  | 'tags'
  | 'action';

function getInstalledSkillHealthRank(
  metrics: AdminAdaptiveSkillHealthMetric | null,
): number {
  if (!metrics) return 2;
  return metrics.degraded ? 1 : 0;
}

const INSTALLED_SKILL_SORTERS: Record<
  InstalledSkillSortKey,
  (left: InstalledSkillRow, right: InstalledSkillRow) => number
> = {
  skill: (left, right) => compareText(left.skill.name, right.skill.name),
  category: (left, right) =>
    compareText(left.skill.category, right.skill.category) ||
    compareText(left.skill.name, right.skill.name),
  source: (left, right) =>
    compareText(left.skill.source, right.skill.source) ||
    compareText(left.skill.name, right.skill.name),
  health: (left, right) =>
    compareNumber(
      getInstalledSkillHealthRank(left.metrics),
      getInstalledSkillHealthRank(right.metrics),
    ) ||
    compareNumber(
      left.metrics?.total_executions,
      right.metrics?.total_executions,
    ) ||
    compareText(left.skill.name, right.skill.name),
  tags: (left, right) =>
    compareText(left.skill.tags.join(', '), right.skill.tags.join(', ')) ||
    compareText(left.skill.name, right.skill.name),
  action: (left, right) =>
    compareBoolean(left.skill.enabled, right.skill.enabled) ||
    compareText(left.skill.name, right.skill.name),
};

const INSTALLED_SKILL_DEFAULT_DIRECTIONS = {
  action: 'desc',
} as const;

type ObservedSkillSortKey =
  | 'skill'
  | 'status'
  | 'executions'
  | 'success'
  | 'toolBreakage'
  | 'feedback'
  | 'reasons';

function getObservedSkillFeedbackCount(
  metrics: AdminAdaptiveSkillHealthMetric,
): number {
  return metrics.positive_feedback_count + metrics.negative_feedback_count;
}

const OBSERVED_SKILL_SORTERS: Record<
  ObservedSkillSortKey,
  (
    left: AdminAdaptiveSkillHealthMetric,
    right: AdminAdaptiveSkillHealthMetric,
  ) => number
> = {
  skill: (left, right) => compareText(left.skill_name, right.skill_name),
  status: (left, right) =>
    compareBoolean(!left.degraded, !right.degraded) ||
    compareText(left.skill_name, right.skill_name),
  executions: (left, right) =>
    compareNumber(left.total_executions, right.total_executions) ||
    compareText(left.skill_name, right.skill_name),
  success: (left, right) =>
    compareNumber(left.success_rate, right.success_rate) ||
    compareText(left.skill_name, right.skill_name),
  toolBreakage: (left, right) =>
    compareNumber(left.tool_breakage_rate, right.tool_breakage_rate) ||
    compareText(left.skill_name, right.skill_name),
  feedback: (left, right) =>
    compareNumber(
      getObservedSkillFeedbackCount(left),
      getObservedSkillFeedbackCount(right),
    ) || compareText(left.skill_name, right.skill_name),
  reasons: (left, right) =>
    compareText(
      left.degradation_reasons.join('; '),
      right.degradation_reasons.join('; '),
    ) || compareText(left.skill_name, right.skill_name),
};

const OBSERVED_SKILL_DEFAULT_DIRECTIONS = {
  status: 'desc',
  executions: 'desc',
  success: 'desc',
  toolBreakage: 'desc',
  feedback: 'desc',
} as const;

interface SkillFileDraft {
  id: number;
  path: string;
  content: string;
}

let nextFileId = 1;

interface SkillDraft {
  name: string;
  description: string;
  category: string;
  shortDescription: string;
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
    category: '',
    shortDescription: '',
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
        category: draft.category.trim(),
        shortDescription: draft.shortDescription.trim() || undefined,
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
  const categoryOptions = Array.from(
    new Set([
      ...DEFAULT_SKILL_CATEGORIES,
      ...(skillsQuery.data?.skills || []).map((skill) => skill.category),
    ]),
  ).sort((left, right) => left.localeCompare(right));
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
      skill.shortDescription || '',
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
  const installedSkillRows = filteredSkills.map((skill) => ({
    skill,
    metrics:
      healthMetrics.find((entry) => entry.skill_name === skill.name) || null,
  }));
  const {
    sortedRows: sortedInstalledSkills,
    sortState: installedSkillSortState,
    toggleSort: toggleInstalledSkillSort,
  } = useSortableRows<InstalledSkillRow, InstalledSkillSortKey>(
    installedSkillRows,
    {
      initialSort: {
        key: 'skill',
        direction: 'asc',
      },
      sorters: INSTALLED_SKILL_SORTERS,
      defaultDirections: INSTALLED_SKILL_DEFAULT_DIRECTIONS,
    },
  );
  const {
    sortedRows: sortedHealthMetrics,
    sortState: observedSkillSortState,
    toggleSort: toggleObservedSkillSort,
  } = useSortableRows<AdminAdaptiveSkillHealthMetric, ObservedSkillSortKey>(
    filteredHealthMetrics,
    {
      initialSort: {
        key: 'skill',
        direction: 'asc',
      },
      sorters: OBSERVED_SKILL_SORTERS,
      defaultDirections: OBSERVED_SKILL_DEFAULT_DIRECTIONS,
    },
  );

  const degradedSkillCount = healthMetrics.filter(
    (metrics) => metrics.degraded,
  ).length;
  const historyEntries = historyQuery.data?.amendments || [];

  return (
    <div className="page-stack">
      <PageHeader
        title="Skills"
        description="Browse installed skills, review health, and manage amendments."
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
              {showCreate ? 'Cancel' : 'New'}
            </button>
          </>
        }
      />

      {showCreate ? (
        <Panel title="Create skill" accent="warm">
          <SegmentedToggle
            ariaLabel="Create mode"
            value={createMode}
            options={[
              { value: 'form', label: 'Form', activeTone: 'is-on' },
              { value: 'zip', label: 'Upload ZIP', activeTone: 'is-on' },
            ]}
            onChange={(value) => {
              if (value === 'form' || value === 'zip') {
                setCreateMode(value);
              }
            }}
          />

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
                  <span>Category</span>
                  <select
                    value={draft.category}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        category: event.target.value,
                      }))
                    }
                  >
                    <option value="">Select category</option>
                    {categoryOptions.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="field-grid">
                <label className="field">
                  <span>Short description</span>
                  <input
                    value={draft.shortDescription}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        shortDescription: event.target.value,
                      }))
                    }
                    placeholder="One-line summary used in metadata"
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
                  label="Model invocable"
                  value={!draft.disableModelInvocation}
                  trueLabel="yes"
                  falseLabel="no"
                  onChange={(modelInvocable) =>
                    setDraft((current) => ({
                      ...current,
                      disableModelInvocation: !modelInvocable,
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
                        {
                          id: nextFileId++,
                          path: 'scripts/new-file.mjs',
                          content: '',
                        },
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
                    !draft.description.trim() ||
                    !draft.category.trim()
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
          href="#observed-skill-health"
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
          href="#staged-amendments"
        />
      </div>

      <Panel
        title="Installed skills"
        subtitle={`${sortedInstalledSkills.length} skill${sortedInstalledSkills.length === 1 ? '' : 's'} visible`}
      >
        {skillsQuery.isLoading ? (
          <div className="empty-state">Loading skill catalog...</div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <SortableHeader
                    label="Skill"
                    sortKey="skill"
                    sortState={installedSkillSortState}
                    onToggle={toggleInstalledSkillSort}
                  />
                  <SortableHeader
                    label="Category"
                    sortKey="category"
                    sortState={installedSkillSortState}
                    onToggle={toggleInstalledSkillSort}
                  />
                  <SortableHeader
                    label="Source"
                    sortKey="source"
                    sortState={installedSkillSortState}
                    onToggle={toggleInstalledSkillSort}
                  />
                  <SortableHeader
                    label="Health"
                    sortKey="health"
                    sortState={installedSkillSortState}
                    onToggle={toggleInstalledSkillSort}
                  />
                  <SortableHeader
                    label="Tags"
                    sortKey="tags"
                    sortState={installedSkillSortState}
                    onToggle={toggleInstalledSkillSort}
                  />
                  <SortableHeader
                    label="Action"
                    sortKey="action"
                    sortState={installedSkillSortState}
                    onToggle={toggleInstalledSkillSort}
                  />
                </tr>
              </thead>
              <tbody>
                {sortedInstalledSkills.map(({ skill, metrics }) => {
                  const feedbackSummary = metrics
                    ? formatFeedbackCounts(metrics)
                    : null;
                  const displayDescription =
                    skill.shortDescription?.trim() ||
                    abbreviateDescription(skill.description);
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
                        <small>{displayDescription}</small>
                      </td>
                      <td>{skill.category}</td>
                      <td>{skill.source}</td>
                      <td>
                        {metrics ? (
                          <>
                            <BooleanPill
                              value={!metrics.degraded}
                              trueLabel="healthy"
                              falseLabel="degraded"
                              falseTone="danger"
                            />
                            <small>
                              {metrics.total_executions} runs
                              {metrics.degraded || !feedbackSummary
                                ? ''
                                : ' · '}
                              {metrics.degraded
                                ? `${formatPercent(metrics.success_rate)} success`
                                : feedbackSummary}
                            </small>
                          </>
                        ) : null}
                      </td>
                      <td>{skill.tags.join(', ') || 'none'}</td>
                      <td>
                        <div className="row-status-stack">
                          <BooleanToggle
                            value={skill.enabled}
                            ariaLabel={`${skill.name} status`}
                            disabled={
                              toggleMutation.isPending ||
                              (!skill.available && !skill.enabled)
                            }
                            trueLabel="active"
                            falseLabel="inactive"
                            onChange={(enabled) => {
                              if (enabled && !skill.available) {
                                return;
                              }
                              toggleMutation.mutate({
                                name: skill.name,
                                enabled,
                              });
                            }}
                          />
                          {!skill.available ? (
                            <small className="row-status-note-danger">
                              {skill.missing.join(', ') ||
                                'missing requirements'}
                            </small>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {sortedInstalledSkills.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
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
          id="observed-skill-health"
          title="Observed skill health"
          subtitle={`${sortedHealthMetrics.length} observed skill${sortedHealthMetrics.length === 1 ? '' : 's'} visible`}
        >
          {healthQuery.isLoading ? (
            <div className="empty-state">Loading AdaptiveSkills health...</div>
          ) : sortedHealthMetrics.length === 0 ? (
            <div className="empty-state">
              No observed skills match this filter.
            </div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <SortableHeader
                      label="Skill"
                      sortKey="skill"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                    <SortableHeader
                      label="Status"
                      sortKey="status"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                    <SortableHeader
                      label="Executions"
                      sortKey="executions"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                    <SortableHeader
                      label="Success"
                      sortKey="success"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                    <SortableHeader
                      label="Tool breakage"
                      sortKey="toolBreakage"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                    <SortableHeader
                      label="Feedback"
                      sortKey="feedback"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                    <SortableHeader
                      label="Reasons"
                      sortKey="reasons"
                      sortState={observedSkillSortState}
                      onToggle={toggleObservedSkillSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedHealthMetrics.map((metrics) => (
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
                          falseTone="danger"
                        />
                      </td>
                      <td>{metrics.total_executions}</td>
                      <td>{formatPercent(metrics.success_rate)}</td>
                      <td>{formatPercent(metrics.tool_breakage_rate)}</td>
                      <td>{formatFeedbackCounts(metrics) || null}</td>
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
          id="staged-amendments"
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
