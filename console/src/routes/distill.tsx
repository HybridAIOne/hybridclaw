import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchDistill,
  recordDistillConsent,
  registerDistillAgent,
  runDistill,
  saveDistillSubject,
  uploadDistillSource,
} from '../api/client';
import type {
  AdminDistillCorpusDocumentSummary,
  AdminDistillEmbeddedText,
  AdminDistillRunSummary,
  AdminDistillSourceKind,
  AdminDistillSubjectSummary,
  AdminDistillUploadResponse,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Checkbox } from '../components/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, MetricCard, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, parseStringList } from '../lib/format';

const DISTILL_STAGE_ORDER = [
  'ingest',
  'analyse',
  'build',
  'merge',
  'correct',
] as const;

const DEFAULT_SOURCE_KINDS: AdminDistillSourceKind[] = [
  'auto',
  'slack-export',
  'email-mbox',
  'transcript',
  'chat-jsonl',
  'markdown',
  'text',
  'interview',
];

function subjectKey(
  subject: Pick<AdminDistillSubjectSummary, 'agentId' | 'alias'>,
) {
  return `${subject.agentId}:${subject.alias}`;
}

function formatRunStatus(run: AdminDistillRunSummary | null): string {
  if (!run) return 'no run';
  return run.status.replace(/-/g, ' ');
}

function statusClass(run: AdminDistillRunSummary | null): string {
  if (!run) return 'status-dot';
  if (run.status === 'completed') return 'status-dot status-dot-success';
  if (run.status === 'failed') return 'status-dot status-dot-danger';
  if (run.status === 'awaiting-extraction') {
    return 'status-dot status-dot-warning';
  }
  return 'status-dot';
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '0 B';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kib = sizeBytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}

function splitManualSources(value: string, kind: AdminDistillSourceKind) {
  return parseStringList(value).map((sourcePath) => ({
    path: sourcePath,
    kind,
  }));
}

function dedupeRunSources(subject: AdminDistillSubjectSummary | null) {
  const seen = new Set<string>();
  const sources: Array<{ path: string; kind: AdminDistillSourceKind }> = [];
  for (const run of subject?.runs || []) {
    for (const source of run.sources) {
      const key = `${source.kind}:${source.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}

function EmbeddedTextDisclosure({
  title,
  artifact,
  path,
}: {
  title: string;
  artifact: AdminDistillEmbeddedText;
  path?: string;
}) {
  return (
    <details className="distill-embed">
      <summary>
        <span>{title}</span>
        <small>
          {artifact.available
            ? `${formatBytes(artifact.byteLength)}${artifact.truncated ? ' preview' : ''}`
            : artifact.error || 'Not available'}
        </small>
      </summary>
      {path ? <code className="path-text">{path}</code> : null}
      {artifact.available ? (
        <pre>{artifact.content || '(empty)'}</pre>
      ) : (
        <div className="empty-state">{artifact.error || 'Not available.'}</div>
      )}
    </details>
  );
}

function StoragePathsDisclosure({
  subject,
}: {
  subject: AdminDistillSubjectSummary;
}) {
  return (
    <details className="distill-embed">
      <summary>
        <span>Storage Paths</span>
        <small>server metadata</small>
      </summary>
      <div className="summary-block distill-path-summary">
        <span>Workspace</span>
        <strong className="path-text">{subject.paths.workspacePath}</strong>
        <span>Uploaded files</span>
        <strong className="path-text">{subject.paths.uploadsPath}</strong>
        <span>Corpus index</span>
        <strong className="path-text">
          {subject.paths.corpusDocumentsPath}
        </strong>
      </div>
    </details>
  );
}

interface SubjectDraft {
  agentId: string;
  alias: string;
  displayName: string;
  role: string;
  relationship: string;
  tags: string;
  matchAliases: string;
  realPerson: boolean;
}

function draftFromSubject(
  subject: AdminDistillSubjectSummary | null,
): SubjectDraft {
  return {
    agentId: subject?.agentId || '',
    alias: subject?.alias || '',
    displayName: subject?.profile.displayName || '',
    role: subject?.profile.role || '',
    relationship: subject?.profile.relationship || '',
    tags: subject?.profile.personalityTags.join(', ') || '',
    matchAliases: subject?.profile.matchAliases.join(', ') || '',
    realPerson: subject?.profile.realPerson ?? true,
  };
}

function runMetrics(subjects: AdminDistillSubjectSummary[]) {
  const runs = subjects.flatMap((subject) => subject.runs);
  return {
    runs,
    awaitingExtraction: runs.filter(
      (run) => run.status === 'awaiting-extraction',
    ).length,
    openReviews: subjects.reduce(
      (total, subject) => total + subject.openReviews,
      0,
    ),
    consentReady: subjects.filter((subject) => subject.consent.valid).length,
  };
}

function LatestRunPanel({ run }: { run: AdminDistillRunSummary | null }) {
  if (!run) {
    return <div className="empty-state">No distillation run yet.</div>;
  }
  return (
    <div className="list-stack distill-run-panel">
      <div className="key-value-grid distill-run-metrics">
        <div>
          <span>Run</span>
          <strong>{run.runId}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{formatRunStatus(run)}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{formatDateTime(run.updatedAt)}</strong>
        </div>
        <div>
          <span>Documents</span>
          <strong>{run.stats.documentsTotal}</strong>
        </div>
      </div>
      <div className="table-shell distill-stage-table">
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {DISTILL_STAGE_ORDER.map((stage) => {
              const state = run.stages[stage];
              return (
                <tr key={stage}>
                  <td>{stage}</td>
                  <td>{state.status}</td>
                  <td>{state.detail || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="distill-embed-list">
        <EmbeddedTextDisclosure
          title="Report"
          artifact={run.artifacts.report}
          path={run.reportPath}
        />
        {run.status === 'awaiting-extraction' ||
        run.artifacts.packetMarkdown.available ? (
          <EmbeddedTextDisclosure
            title="Analysis Packet"
            artifact={run.artifacts.packetMarkdown}
            path={run.packetMarkdownPath}
          />
        ) : null}
        {run.status === 'awaiting-extraction' ||
        run.artifacts.extraction.available ? (
          <EmbeddedTextDisclosure
            title="Extraction"
            artifact={run.artifacts.extraction}
            path={run.extractionPath}
          />
        ) : null}
      </div>
    </div>
  );
}

function SourceRows({
  sources,
  emptyLabel,
}: {
  sources: Array<{ path: string; kind: AdminDistillSourceKind }>;
  emptyLabel: string;
}) {
  if (sources.length === 0) {
    return <div className="empty-state">{emptyLabel}</div>;
  }
  return (
    <ul className="distill-data-list">
      {sources.map((source) => (
        <li className="distill-data-row" key={`${source.kind}:${source.path}`}>
          <div>
            <strong>{source.kind}</strong>
            <code className="path-text">{source.path}</code>
          </div>
        </li>
      ))}
    </ul>
  );
}

function QueuedUploadRows({
  uploads,
}: {
  uploads: AdminDistillUploadResponse[];
}) {
  if (uploads.length === 0) {
    return <div className="empty-state">No queued uploads.</div>;
  }
  return (
    <ul className="distill-data-list">
      {uploads.map((upload) => (
        <li
          className="distill-data-row"
          key={`${upload.source.kind}:${upload.path}`}
        >
          <div>
            <strong>
              {upload.filename} · {upload.source.kind} ·{' '}
              {formatBytes(upload.sizeBytes)}
            </strong>
            <code className="path-text">{upload.path}</code>
            <EmbeddedTextDisclosure title="Preview" artifact={upload.preview} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CorpusRows({
  documents,
}: {
  documents: AdminDistillCorpusDocumentSummary[];
}) {
  if (documents.length === 0) {
    return <div className="empty-state">No corpus documents ingested yet.</div>;
  }
  return (
    <ul className="distill-data-list">
      {documents.map((document) => (
        <li className="distill-data-row" key={document.id}>
          <div>
            <strong>{document.id}</strong>
            <small>
              {document.source} · {document.wordCount} words ·{' '}
              {document.holdout ? 'holdout' : 'analysis'} · {document.author}
            </small>
            <code className="path-text">{document.origin}</code>
            <EmbeddedTextDisclosure
              title="Content Preview"
              artifact={document.contentPreview}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SourceDataPanel({
  subject,
  queuedUploads,
}: {
  subject: AdminDistillSubjectSummary | null;
  queuedUploads: AdminDistillUploadResponse[];
}) {
  if (!subject) {
    return <div className="empty-state">No subject selected.</div>;
  }
  const runSources = dedupeRunSources(subject);
  return (
    <div className="list-stack">
      <StoragePathsDisclosure subject={subject} />

      {queuedUploads.length > 0 ? (
        <section className="distill-data-section">
          <h5>Queued Uploads</h5>
          <QueuedUploadRows uploads={queuedUploads} />
        </section>
      ) : null}

      <section className="distill-data-section">
        <h5>Run Sources</h5>
        <SourceRows
          sources={runSources}
          emptyLabel="No sources attached to a run yet."
        />
      </section>

      <section className="distill-data-section">
        <h5>Corpus Documents</h5>
        <CorpusRows documents={subject.corpus} />
      </section>
    </div>
  );
}

export function DistillPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState('');
  const [subjectDraft, setSubjectDraft] = useState<SubjectDraft>(
    draftFromSubject(null),
  );
  const [sourceKind, setSourceKind] = useState<AdminDistillSourceKind>('auto');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadedSources, setUploadedSources] = useState<
    AdminDistillUploadResponse[]
  >([]);
  const [manualSources, setManualSources] = useState('');
  const [holdoutRatio, setHoldoutRatio] = useState('0.1');
  const [consent, setConsent] = useState({
    grantedBy: '',
    method: 'written',
    statement: '',
  });

  const query = useQuery({
    queryKey: ['admin', 'distill', auth.token],
    queryFn: () => fetchDistill(auth.token),
  });

  const subjects = query.data?.subjects || [];
  useEffect(() => {
    if (!selectedKey && subjects.length > 0) {
      setSelectedKey(subjectKey(subjects[0]));
    }
  }, [selectedKey, subjects]);

  const selectedSubject = useMemo(
    () =>
      subjects.find((subject) => subjectKey(subject) === selectedKey) || null,
    [selectedKey, subjects],
  );

  useEffect(() => {
    setSubjectDraft(draftFromSubject(selectedSubject));
    if (selectedSubject) {
      setConsent((current) => ({
        ...current,
        grantedBy: current.grantedBy || selectedSubject.profile.displayName,
      }));
    }
  }, [selectedSubject]);

  const sourceKinds = query.data?.sourceKinds || DEFAULT_SOURCE_KINDS;
  const metrics = runMetrics(subjects);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'distill'] });

  const subjectMutation = useMutation({
    mutationFn: () =>
      saveDistillSubject(auth.token, {
        agentId: subjectDraft.agentId || undefined,
        alias: subjectDraft.alias,
        displayName: subjectDraft.displayName || undefined,
        role: subjectDraft.role || undefined,
        relationship: subjectDraft.relationship || undefined,
        realPerson: subjectDraft.realPerson,
        personalityTags: parseStringList(subjectDraft.tags),
        matchAliases: parseStringList(subjectDraft.matchAliases),
      }),
    onSuccess: async (result) => {
      setSelectedKey(subjectKey(result.subject));
      toast.success('Subject saved');
      await invalidate();
    },
    onError: (error) =>
      toast.error('Subject save failed', getErrorMessage(error)),
  });

  const consentMutation = useMutation({
    mutationFn: () =>
      recordDistillConsent(auth.token, {
        agentId: subjectDraft.agentId || undefined,
        alias: subjectDraft.alias,
        subjectName: subjectDraft.displayName || undefined,
        grantedBy: consent.grantedBy,
        method: consent.method,
        statement: consent.statement,
      }),
    onSuccess: async (result) => {
      setSelectedKey(subjectKey(result.subject));
      toast.success('Consent recorded');
      await invalidate();
    },
    onError: (error) =>
      toast.error('Consent record failed', getErrorMessage(error)),
  });

  const registerMutation = useMutation({
    mutationFn: () =>
      registerDistillAgent(auth.token, {
        agentId: subjectDraft.agentId || undefined,
        alias: subjectDraft.alias,
      }),
    onSuccess: async (result) => {
      setSelectedKey(subjectKey(result.subject));
      toast.success('Agent registered');
      await invalidate();
    },
    onError: (error) =>
      toast.error('Agent registration failed', getErrorMessage(error)),
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const uploaded: AdminDistillUploadResponse[] = [];
      for (const file of pendingFiles) {
        uploaded.push(
          await uploadDistillSource(auth.token, file, {
            alias: subjectDraft.alias,
            agentId: subjectDraft.agentId || undefined,
            kind: sourceKind,
          }),
        );
      }
      return uploaded;
    },
    onSuccess: (result) => {
      setUploadedSources((current) => [...current, ...result]);
      setPendingFiles([]);
      toast.success('Source upload complete');
    },
    onError: (error) => toast.error('Upload failed', getErrorMessage(error)),
  });

  const runMutation = useMutation({
    mutationFn: (resumeRunId?: string) =>
      runDistill(auth.token, {
        agentId: subjectDraft.agentId || undefined,
        alias: subjectDraft.alias,
        displayName: subjectDraft.displayName || undefined,
        role: subjectDraft.role || undefined,
        relationship: subjectDraft.relationship || undefined,
        realPerson: subjectDraft.realPerson,
        personalityTags: parseStringList(subjectDraft.tags),
        matchAliases: parseStringList(subjectDraft.matchAliases),
        sources: resumeRunId
          ? []
          : [
              ...uploadedSources.map((upload) => upload.source),
              ...splitManualSources(manualSources, sourceKind),
            ],
        resumeRunId,
        holdoutRatio: Number(holdoutRatio),
        kind: sourceKind,
      }),
    onSuccess: async (result) => {
      setSelectedKey(subjectKey(result.subject));
      setUploadedSources([]);
      setManualSources('');
      toast.success(`Run ${formatRunStatus(result.run)}`);
      await invalidate();
    },
    onError: (error) =>
      toast.error('Distillation failed', getErrorMessage(error)),
  });

  if (query.isLoading) {
    return <div className="empty-state">Loading distillation workspace...</div>;
  }

  if (query.isError) {
    return (
      <div className="empty-state error">{getErrorMessage(query.error)}</div>
    );
  }

  const readyToRun =
    subjectDraft.alias.trim() &&
    (uploadedSources.length > 0 || parseStringList(manualSources).length > 0);
  const latestRun = selectedSubject?.latestRun || null;

  return (
    <div className="page-stack">
      <PageHeader
        description="Human distillation intake, consent, source upload, and run control."
        actions={
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            Refresh
          </Button>
        }
      />

      <div className="metric-grid">
        <MetricCard label="Subjects" value={String(subjects.length)} />
        <MetricCard label="Runs" value={String(metrics.runs.length)} />
        <MetricCard
          label="Awaiting Extraction"
          value={String(metrics.awaitingExtraction)}
        />
        <MetricCard label="Open Reviews" value={String(metrics.openReviews)} />
      </div>

      <div className="two-column-grid">
        <div className="page-stack">
          <Card>
            <CardHeader>
              <CardTitle>Subject</CardTitle>
              <CardDescription>
                Persona target and authorship aliases.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="stack-form">
                {subjects.length > 0 ? (
                  <Field>
                    <FieldLabel>Existing subject</FieldLabel>
                    <FieldContent>
                      <NativeSelect
                        value={selectedKey}
                        onChange={(event) => setSelectedKey(event.target.value)}
                      >
                        {subjects.map((subject) => (
                          <NativeSelectOption
                            key={subjectKey(subject)}
                            value={subjectKey(subject)}
                          >
                            {subject.profile.displayName} ({subject.agentId}/
                            {subject.alias})
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </FieldContent>
                  </Field>
                ) : null}
                <div className="field-grid">
                  <Field>
                    <FieldLabel>Alias</FieldLabel>
                    <FieldContent>
                      <Input
                        value={subjectDraft.alias}
                        onChange={(event) =>
                          setSubjectDraft((current) => ({
                            ...current,
                            alias: event.target.value,
                          }))
                        }
                      />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel>Agent</FieldLabel>
                    <FieldContent>
                      <Input
                        placeholder="defaults to alias"
                        value={subjectDraft.agentId}
                        onChange={(event) =>
                          setSubjectDraft((current) => ({
                            ...current,
                            agentId: event.target.value,
                          }))
                        }
                      />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel>Name</FieldLabel>
                    <FieldContent>
                      <Input
                        value={subjectDraft.displayName}
                        onChange={(event) =>
                          setSubjectDraft((current) => ({
                            ...current,
                            displayName: event.target.value,
                          }))
                        }
                      />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel>Role</FieldLabel>
                    <FieldContent>
                      <Input
                        value={subjectDraft.role}
                        onChange={(event) =>
                          setSubjectDraft((current) => ({
                            ...current,
                            role: event.target.value,
                          }))
                        }
                      />
                    </FieldContent>
                  </Field>
                </div>
                <Field>
                  <FieldLabel>Match aliases</FieldLabel>
                  <FieldContent>
                    <Input
                      value={subjectDraft.matchAliases}
                      onChange={(event) =>
                        setSubjectDraft((current) => ({
                          ...current,
                          matchAliases: event.target.value,
                        }))
                      }
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel>Tags</FieldLabel>
                  <FieldContent>
                    <Input
                      value={subjectDraft.tags}
                      onChange={(event) =>
                        setSubjectDraft((current) => ({
                          ...current,
                          tags: event.target.value,
                        }))
                      }
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldContent>
                    <label className="button-row">
                      <Checkbox
                        checked={subjectDraft.realPerson}
                        onCheckedChange={(checked) =>
                          setSubjectDraft((current) => ({
                            ...current,
                            realPerson: checked,
                          }))
                        }
                      />
                      <span>Real person</span>
                    </label>
                  </FieldContent>
                </Field>
                <div className="button-row">
                  <Button
                    onClick={() => subjectMutation.mutate()}
                    loading={subjectMutation.isPending}
                    disabled={!subjectDraft.alias.trim()}
                  >
                    Save Subject
                  </Button>
                  {selectedSubject && !selectedSubject.registeredAgent ? (
                    <Button
                      variant="outline"
                      onClick={() => registerMutation.mutate()}
                      loading={registerMutation.isPending}
                      disabled={!subjectDraft.alias.trim()}
                    >
                      Register Agent
                    </Button>
                  ) : null}
                  {selectedSubject?.registeredAgent ? (
                    <BooleanPill value={true} trueLabel="Agent registered" />
                  ) : null}
                  {selectedSubject ? (
                    <BooleanPill
                      value={selectedSubject.consent.valid}
                      trueLabel="Consent valid"
                      falseLabel="Consent needed"
                      falseTone="danger"
                    />
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Consent</CardTitle>
              <CardDescription>
                Recorded artefact for real-person distillation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="stack-form">
                <div className="field-grid">
                  <Field>
                    <FieldLabel>Granted by</FieldLabel>
                    <FieldContent>
                      <Input
                        value={consent.grantedBy}
                        onChange={(event) =>
                          setConsent((current) => ({
                            ...current,
                            grantedBy: event.target.value,
                          }))
                        }
                      />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel>Method</FieldLabel>
                    <FieldContent>
                      <Input
                        value={consent.method}
                        onChange={(event) =>
                          setConsent((current) => ({
                            ...current,
                            method: event.target.value,
                          }))
                        }
                      />
                    </FieldContent>
                  </Field>
                </div>
                <Field>
                  <FieldLabel>Statement</FieldLabel>
                  <FieldContent>
                    <Textarea
                      value={consent.statement}
                      onChange={(event) =>
                        setConsent((current) => ({
                          ...current,
                          statement: event.target.value,
                        }))
                      }
                    />
                  </FieldContent>
                </Field>
                <Button
                  onClick={() => consentMutation.mutate()}
                  loading={consentMutation.isPending}
                  disabled={
                    !subjectDraft.alias.trim() ||
                    !consent.grantedBy.trim() ||
                    !consent.method.trim() ||
                    !consent.statement.trim()
                  }
                >
                  Record Consent
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sources</CardTitle>
              <CardDescription>
                Uploaded files and host paths for the next run.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="stack-form">
                <Field>
                  <FieldLabel>Kind</FieldLabel>
                  <FieldContent>
                    <NativeSelect
                      value={sourceKind}
                      onChange={(event) =>
                        setSourceKind(
                          event.target.value as AdminDistillSourceKind,
                        )
                      }
                    >
                      {sourceKinds.map((kind) => (
                        <NativeSelectOption key={kind} value={kind}>
                          {kind}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel>Files</FieldLabel>
                  <FieldContent>
                    <Input
                      type="file"
                      multiple
                      onChange={(event) =>
                        setPendingFiles(Array.from(event.target.files || []))
                      }
                    />
                  </FieldContent>
                </Field>
                <Button
                  variant="outline"
                  onClick={() => uploadMutation.mutate()}
                  loading={uploadMutation.isPending}
                  disabled={
                    !subjectDraft.alias.trim() || pendingFiles.length === 0
                  }
                >
                  Upload Files
                </Button>
                <Field>
                  <FieldLabel>Host paths</FieldLabel>
                  <FieldContent>
                    <Textarea
                      value={manualSources}
                      onChange={(event) => setManualSources(event.target.value)}
                    />
                  </FieldContent>
                </Field>
                {uploadedSources.length > 0 ? (
                  <QueuedUploadRows uploads={uploadedSources} />
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Run</CardTitle>
              <CardDescription>Pipeline execution and resume.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="stack-form">
                <Field>
                  <FieldLabel>Holdout ratio</FieldLabel>
                  <FieldDescription>
                    Reserves part of the corpus for later fidelity checks. 10%
                    means one in ten documents is kept out of the distillation
                    packet.
                  </FieldDescription>
                  <FieldContent>
                    <Input
                      type="number"
                      min="0"
                      max="0.5"
                      step="0.05"
                      value={holdoutRatio}
                      onChange={(event) => setHoldoutRatio(event.target.value)}
                    />
                  </FieldContent>
                </Field>
                <div className="button-row">
                  <Button
                    onClick={() => runMutation.mutate(undefined)}
                    loading={runMutation.isPending}
                    disabled={!readyToRun}
                  >
                    Start Distill
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      latestRun
                        ? runMutation.mutate(latestRun.runId)
                        : undefined
                    }
                    loading={runMutation.isPending}
                    disabled={!latestRun}
                  >
                    Resume Latest
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="page-stack">
          <Card>
            <CardHeader>
              <CardTitle>Subjects</CardTitle>
              <CardDescription>
                {metrics.consentReady} with valid consent.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {subjects.length === 0 ? (
                <div className="empty-state">No distillation subjects.</div>
              ) : (
                <div className="list-stack">
                  {subjects.map((subject) => (
                    <button
                      key={subjectKey(subject)}
                      className="list-row"
                      type="button"
                      onClick={() => setSelectedKey(subjectKey(subject))}
                    >
                      <div>
                        <strong>{subject.profile.displayName}</strong>
                        <small>
                          {subject.agentId}/{subject.alias} ·{' '}
                          {subject.corpusDocuments} docs · {subject.runs.length}{' '}
                          runs ·{' '}
                          {subject.registeredAgent
                            ? 'registered'
                            : 'unregistered'}
                        </small>
                      </div>
                      <span className="status-pill">
                        <span className={statusClass(subject.latestRun)} />
                        {formatRunStatus(subject.latestRun)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Latest Run</CardTitle>
              <CardDescription>
                {selectedSubject?.profile.displayName || 'No subject selected'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LatestRunPanel run={latestRun} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Source Data</CardTitle>
              <CardDescription>
                Uploaded files, source paths, and ingested corpus records.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SourceDataPanel
                subject={selectedSubject}
                queuedUploads={uploadedSources}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
