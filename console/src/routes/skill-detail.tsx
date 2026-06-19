import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSkillPackageFile,
  fetchSkillPackageFiles,
  fetchSkills,
  saveSkillEnabled,
  saveSkillPackageFile,
} from '../api/client';
import type { AdminSkill, AdminSkillPackageFile } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { ChevronLeft, ChevronRight } from '../components/icons';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, SegmentedToggle } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

type SkillDetailTab = 'description' | 'tutorial' | 'prompts';
type SkillScreenshot = NonNullable<AdminSkill['docs']>['screenshots'][number];

export function skillDetailPath(skillName: string): string {
  return `/admin/skills/${encodeURIComponent(skillName)}`;
}

function decodeSkillNameParam(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getSkillDetailPromptCount(skill: AdminSkill): number {
  return skill.docs?.examplePrompts.length ?? 0;
}

function formatInstallSpec(spec: AdminSkill['install'][number]): string {
  if (spec.label?.trim()) return spec.label.trim();
  if (spec.package) return `${spec.kind}: ${spec.package}`;
  if (spec.formula) return `${spec.kind}: ${spec.formula}`;
  if (spec.module) return `${spec.kind}: ${spec.module}`;
  if (spec.url) return `${spec.kind}: ${spec.url}`;
  return spec.id ? `${spec.kind}: ${spec.id}` : spec.kind;
}

function formatCredentialRequirement(
  credential: AdminSkill['credentials'][number],
): string {
  return `${credential.id} · ${credential.kind}${credential.required ? ' · required' : ''}`;
}

function formatConfigVariableRequirement(
  variable: AdminSkill['configVariables'][number],
): string {
  return `${variable.env}${variable.required ? ' · required' : ''}`;
}

function buildSkillPromptCommand(skillName: string, prompt: string): string {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) return `/${skillName}`;
  return trimmedPrompt.startsWith('/')
    ? trimmedPrompt
    : `/${skillName} ${trimmedPrompt}`;
}

function skillPromptChatHref(skillName: string, prompt: string): string {
  const query = new URLSearchParams({
    prompt: buildSkillPromptCommand(skillName, prompt),
  });
  return `/chat?${query.toString()}`;
}

function ChipList(props: { values: string[]; empty: string }) {
  if (props.values.length === 0) {
    return <p className="supporting-text">{props.empty}</p>;
  }

  return (
    <div className="skill-chip-list">
      {props.values.map((value) => (
        <span className="meta-chip" key={value}>
          {value}
        </span>
      ))}
    </div>
  );
}

function SkillMarkdown(props: { markdown: string }) {
  const html = useMemo(
    () => renderMarkdown(props.markdown, { highlight: false }),
    [props.markdown],
  );

  if (!html) {
    return <div className="empty-state">No tutorial is documented yet.</div>;
  }

  return (
    <div
      className="skill-markdown"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown is sanitized by renderMarkdown before insertion
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function SkillScreenshotGallery(props: { screenshots: SkillScreenshot[] }) {
  const railRef = useRef<HTMLDivElement>(null);

  if (props.screenshots.length === 0) return null;

  const scrollGallery = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({
      left: direction * Math.max(rail.clientWidth * 0.8, 320),
      behavior: 'smooth',
    });
  };

  return (
    <section className="skill-screenshot-section" aria-labelledby="screenshots">
      <div className="skill-screenshot-header">
        <h2 id="screenshots">Screenshots</h2>
        {props.screenshots.length > 1 ? (
          <div className="skill-screenshot-controls">
            <Button
              aria-label="Previous screenshot"
              size="icon"
              variant="outline"
              onClick={() => scrollGallery(-1)}
            >
              <ChevronLeft aria-hidden="true" width={18} height={18} />
            </Button>
            <Button
              aria-label="Next screenshot"
              size="icon"
              variant="outline"
              onClick={() => scrollGallery(1)}
            >
              <ChevronRight aria-hidden="true" width={18} height={18} />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="skill-screenshot-gallery" ref={railRef}>
        {props.screenshots.map((screenshot) => (
          <figure className="skill-screenshot-frame" key={screenshot.src}>
            <img alt={screenshot.alt} loading="lazy" src={screenshot.src} />
            {screenshot.title ? (
              <figcaption>{screenshot.title}</figcaption>
            ) : null}
          </figure>
        ))}
      </div>
    </section>
  );
}

function formatSkillFileSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return 'directory';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDefaultSkillFilePath(
  files: AdminSkillPackageFile[],
): string | null {
  return (
    files.find((file) => file.path === 'SKILL.md' && file.previewable)?.path ||
    files.find((file) => file.previewable)?.path ||
    files.find((file) => file.kind === 'file')?.path ||
    files[0]?.path ||
    null
  );
}

function getSkillFileDocumentKey(
  skillName: string,
  filePath: string | null,
): string | null {
  if (!skillName || !filePath) return null;
  return `${skillName}:${filePath}`;
}

function SkillPackageFileBrowser(props: { skillName: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const hydratedDocumentKeyRef = useRef<string | null>(null);
  const hydratedContentRef = useRef('');

  const filesQuery = useQuery({
    queryKey: ['skill-package-files', auth.token, props.skillName],
    queryFn: () => fetchSkillPackageFiles(auth.token, props.skillName),
    refetchOnWindowFocus: false,
  });

  const selectedSummary =
    filesQuery.data?.files.find((file) => file.path === selectedPath) || null;
  const selectedDocumentKey = getSkillFileDocumentKey(
    props.skillName,
    selectedPath,
  );

  useEffect(() => {
    if (!filesQuery.data) return;
    const selectedStillExists = filesQuery.data.files.some(
      (file) => file.path === selectedPath,
    );
    if (selectedStillExists) return;
    setSelectedPath(getDefaultSkillFilePath(filesQuery.data.files));
  }, [filesQuery.data, selectedPath]);

  const fileQuery = useQuery({
    queryKey: ['skill-package-file', auth.token, props.skillName, selectedPath],
    queryFn: () =>
      fetchSkillPackageFile(auth.token, {
        skillName: props.skillName,
        path: selectedPath || '',
      }),
    enabled: Boolean(selectedPath && selectedSummary?.previewable),
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
    const nextContent = fileQuery.data.file.content || '';
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
      if (!selectedPath) throw new Error('Select a skill file first.');
      if (!selectedSummary?.editable) {
        throw new Error('Select an editable skill file first.');
      }
      return saveSkillPackageFile(auth.token, {
        skillName: props.skillName,
        path: selectedPath,
        content: draftContent,
      });
    },
    onSuccess: (payload) => {
      const nextDocumentKey = getSkillFileDocumentKey(
        payload.skillName,
        payload.file.path,
      );
      queryClient.setQueryData(
        [
          'skill-package-file',
          auth.token,
          payload.skillName,
          payload.file.path,
        ],
        payload,
      );
      void queryClient.invalidateQueries({
        queryKey: ['skill-package-files', auth.token, payload.skillName],
      });
      hydratedDocumentKeyRef.current = nextDocumentKey;
      hydratedContentRef.current = payload.file.content || '';
      setDraftContent(payload.file.content || '');
      toast.success(`Saved ${payload.file.path}.`);
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const isDirty = draftContent !== hydratedContentRef.current;
  const loadedFile = fileQuery.data?.file;
  const packageFiles = filesQuery.data?.files || [];
  const canEditSelected =
    Boolean(selectedSummary?.editable) &&
    Boolean(loadedFile) &&
    loadedFile?.path === selectedSummary?.path &&
    loadedFile?.content !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Package files</CardTitle>
        <CardDescription>
          {filesQuery.data?.rootPath || 'Loading package directory...'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {filesQuery.isError ? (
          <div className="empty-state error">
            {getErrorMessage(filesQuery.error)}
          </div>
        ) : filesQuery.isLoading ? (
          <div className="empty-state">Loading package files...</div>
        ) : packageFiles.length === 0 ? (
          <div className="empty-state">No package files found.</div>
        ) : (
          <div className="skill-file-browser">
            <div className="skill-file-list">
              {packageFiles.map((file) => (
                <button
                  className={`skill-file-row ${file.path === selectedPath ? 'is-selected' : ''}`}
                  key={file.path}
                  onClick={() => setSelectedPath(file.path)}
                  type="button"
                >
                  <span className="skill-file-name">{file.path}</span>
                  <span className="skill-file-meta">
                    {file.kind} · {formatSkillFileSize(file.sizeBytes)}
                  </span>
                </button>
              ))}
            </div>

            <div className="skill-file-editor">
              {selectedSummary ? (
                <div className="skill-file-editor-header">
                  <div>
                    <strong>{selectedSummary.path}</strong>
                    <span>
                      {selectedSummary.updatedAt
                        ? formatDateTime(selectedSummary.updatedAt)
                        : 'not modified'}
                    </span>
                  </div>
                  <div className="skill-file-editor-actions">
                    <Button
                      disabled={
                        !canEditSelected || !isDirty || saveMutation.isPending
                      }
                      loading={saveMutation.isPending}
                      onClick={() => saveMutation.mutate()}
                      size="sm"
                    >
                      Save
                    </Button>
                    <Button
                      disabled={!isDirty || saveMutation.isPending}
                      onClick={() => {
                        setDraftContent(hydratedContentRef.current);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Discard
                    </Button>
                  </div>
                </div>
              ) : null}

              {!selectedSummary ? (
                <div className="empty-state">Select a package file.</div>
              ) : selectedSummary.kind !== 'file' ? (
                <div className="empty-state">Directory selected.</div>
              ) : !selectedSummary.previewable ? (
                <div className="empty-state">
                  This file is not editable in the admin preview.
                </div>
              ) : fileQuery.isLoading ? (
                <div className="empty-state">Loading file...</div>
              ) : fileQuery.isError ? (
                <div className="empty-state error">
                  {getErrorMessage(fileQuery.error)}
                </div>
              ) : (
                <Textarea
                  aria-label={`Edit ${selectedSummary.path}`}
                  className="code-editor skill-file-textarea"
                  onChange={(event) => setDraftContent(event.target.value)}
                  onInput={(event) =>
                    setDraftContent(event.currentTarget.value)
                  }
                  readOnly={!canEditSelected || saveMutation.isPending}
                  spellCheck={false}
                  value={draftContent}
                />
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SkillDetailView(props: { skillName: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<SkillDetailTab>('description');
  const skillsQuery = useQuery({
    queryKey: ['skills', auth.token],
    queryFn: () => fetchSkills(auth.token),
  });
  const toggleMutation = useMutation({
    mutationFn: (payload: { name: string; enabled: boolean }) =>
      saveSkillEnabled(auth.token, payload),
    onSuccess: (payload) => {
      queryClient.setQueryData(['skills', auth.token], payload);
    },
    onError: (error) => {
      toast.error('Toggle failed', getErrorMessage(error));
    },
  });

  const skill = skillsQuery.data?.skills.find(
    (entry) => entry.name === props.skillName,
  );

  if (skillsQuery.isLoading) {
    return (
      <div className="page-stack">
        <div className="empty-state">Loading skill...</div>
      </div>
    );
  }

  if (skillsQuery.isError) {
    return (
      <div className="page-stack">
        <Button
          variant="ghost"
          render={<Link to="/admin/skills">Back to skills</Link>}
        />
        <Card>
          <CardContent>
            <div className="empty-state error">
              {getErrorMessage(skillsQuery.error)}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="page-stack">
        <Button
          variant="ghost"
          render={<Link to="/admin/skills">Back to skills</Link>}
        />
        <Card>
          <CardContent>
            <div className="empty-state">Skill not found.</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tools = [
    ...(skill.capabilities || []).map(
      (capability) => `capability: ${capability}`,
    ),
    ...(skill.requires?.bins || []).map((bin) => `bin: ${bin}`),
  ];
  const envRequirements = skill.requires?.env || [];
  const installSpecs = skill.install || [];
  const prompts = skill.docs?.examplePrompts || [];
  const screenshots = skill.docs?.screenshots || [];
  const docsHref = skill.docs?.sourceHref;

  return (
    <div className="page-stack skill-detail-page">
      <div className="skill-detail-back-row">
        <Button
          variant="ghost"
          render={<Link to="/admin/skills">Back to skills</Link>}
        />
      </div>

      <section className="skill-detail-hero">
        <div
          className="skill-detail-icon"
          aria-hidden={skill.logoUrl ? undefined : true}
        >
          {skill.logoUrl ? (
            <img src={skill.logoUrl} alt={`${skill.name} logo`} />
          ) : (
            skill.name.slice(0, 1).toUpperCase()
          )}
        </div>
        <div className="skill-detail-title">
          <div>
            <h1>{skill.name}</h1>
            <p>{skill.shortDescription || skill.description}</p>
          </div>
          <div className="skill-detail-status-row">
            <BooleanPill
              value={skill.enabled && skill.available && !skill.blocked}
              trueLabel="enabled"
              falseLabel={skill.blocked ? 'blocked' : 'disabled'}
              falseTone={skill.blocked ? 'danger' : 'default'}
            />
            {!skill.blocked ? (
              <label className="skill-detail-enable-control">
                <Switch
                  checked={skill.enabled}
                  aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                  disabled={
                    toggleMutation.isPending ||
                    (!skill.available && !skill.enabled)
                  }
                  onCheckedChange={(enabled) => {
                    if (enabled && !skill.available) return;
                    toggleMutation.mutate({
                      name: skill.name,
                      enabled,
                    });
                  }}
                />
                <span>
                  {toggleMutation.isPending
                    ? 'Saving...'
                    : skill.enabled
                      ? 'Enabled'
                      : 'Enable'}
                </span>
              </label>
            ) : null}
            <span className="status-pill">{skill.category}</span>
            <span className="status-pill">{skill.source}</span>
          </div>
          {!skill.blocked && !skill.available ? (
            <p className="skill-detail-status-note">
              {skill.missing.join(', ') || 'missing requirements'}
            </p>
          ) : null}
        </div>
      </section>

      <div className="skill-detail-summary-grid">
        <div className="skill-detail-summary-item">
          <span>Developer</span>
          <strong>{skill.developer}</strong>
        </div>
        <div className="skill-detail-summary-item">
          <span>Tools</span>
          <strong>{tools.length}</strong>
        </div>
        <div className="skill-detail-summary-item">
          <span>Prompts</span>
          <strong>{getSkillDetailPromptCount(skill)}</strong>
        </div>
        <div className="skill-detail-summary-item">
          <span>Dependencies</span>
          <strong>{installSpecs.length}</strong>
        </div>
      </div>

      <SkillScreenshotGallery screenshots={screenshots} />

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
          <CardDescription>{skill.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <SegmentedToggle
            ariaLabel="Skill detail tabs"
            value={activeTab}
            size="sm"
            options={[
              {
                value: 'description',
                label: 'Description',
                activeTone: 'is-on',
              },
              { value: 'tutorial', label: 'Tutorial', activeTone: 'is-on' },
              { value: 'prompts', label: 'Prompts', activeTone: 'is-on' },
            ]}
            onChange={setActiveTab}
          />

          {activeTab === 'description' ? (
            <div className="skill-description-panel">
              <p>{skill.description}</p>
              {skill.relatedSkills.length > 0 ? (
                <>
                  <h4>Related skills</h4>
                  <ChipList values={skill.relatedSkills} empty="" />
                </>
              ) : null}
              {skill.tags.length > 0 ? (
                <>
                  <h4>Tags</h4>
                  <ChipList values={skill.tags} empty="" />
                </>
              ) : null}
            </div>
          ) : activeTab === 'tutorial' ? (
            <div className="skill-tutorial-panel">
              {docsHref ? (
                <a className="skill-doc-source-link" href={docsHref}>
                  {skill.docs?.sourcePath}
                </a>
              ) : null}
              <SkillMarkdown markdown={skill.docs?.tutorialMarkdown || ''} />
            </div>
          ) : (
            <div className="skill-prompt-list">
              {prompts.length === 0 ? (
                <div className="empty-state">
                  No example prompts documented.
                </div>
              ) : (
                prompts.map((prompt) => (
                  <div
                    className="skill-prompt-row"
                    key={`${prompt.kind}-${prompt.conversationId ?? 'single'}-${prompt.turnIndex ?? prompt.prompt}`}
                  >
                    <a
                      aria-label={`Try it: ${buildSkillPromptCommand(skill.name, prompt.prompt)}`}
                      className="skill-prompt-try-button"
                      href={skillPromptChatHref(skill.name, prompt.prompt)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Try it
                    </a>
                    <code>{prompt.prompt}</code>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {skill.available && !skill.blocked ? (
        <SkillPackageFileBrowser skillName={skill.name} />
      ) : null}

      <div className="two-column-grid skill-detail-grid">
        <Card>
          <CardHeader>
            <CardTitle>Tools</CardTitle>
            <CardDescription>
              Declared capabilities and required runtime binaries.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChipList
              values={tools}
              empty="No explicit capabilities or binaries declared."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dependencies</CardTitle>
            <CardDescription>
              Install metadata and required environment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="detail-stack">
              {installSpecs.length > 0 ? (
                <div className="skill-detail-list">
                  {installSpecs.map((spec, index) => (
                    <div
                      className="skill-detail-list-row"
                      key={spec.id || index}
                    >
                      <strong>{formatInstallSpec(spec)}</strong>
                      {spec.bins?.length ? (
                        <small>bins: {spec.bins.join(', ')}</small>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="supporting-text">
                  No install dependencies declared.
                </p>
              )}
              <ChipList
                values={envRequirements.map((env) => `env: ${env}`)}
                empty="No required environment variables declared."
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="two-column-grid skill-detail-grid">
        <Card>
          <CardHeader>
            <CardTitle>Credentials</CardTitle>
          </CardHeader>
          <CardContent>
            {skill.credentials.length === 0 ? (
              <p className="supporting-text">No credentials declared.</p>
            ) : (
              <div className="skill-detail-list">
                {skill.credentials.map((credential) => (
                  <div className="skill-detail-list-row" key={credential.id}>
                    <strong>{formatCredentialRequirement(credential)}</strong>
                    <small>{credential.secretRef.id}</small>
                    {credential.scope ? (
                      <small>{credential.scope}</small>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            {skill.configVariables.length === 0 ? (
              <p className="supporting-text">No config variables declared.</p>
            ) : (
              <div className="skill-detail-list">
                {skill.configVariables.map((variable) => (
                  <div className="skill-detail-list-row" key={variable.id}>
                    <strong>{formatConfigVariableRequirement(variable)}</strong>
                    {variable.scope ? <small>{variable.scope}</small> : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {skill.blocked ? (
        <Card>
          <CardHeader>
            <CardTitle>Guard findings</CardTitle>
            <CardDescription>{skill.blockedReason}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="skill-detail-list">
              {(skill.guardFindings || []).map((finding) => (
                <div
                  className="skill-detail-list-row"
                  key={`${finding.patternId}-${finding.file}-${finding.line}`}
                >
                  <strong>
                    {finding.severity}/{finding.category}
                  </strong>
                  <small>
                    {finding.file}:{finding.line}
                  </small>
                  <small>{finding.description}</small>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function SkillsDetailPage() {
  const params = useParams({ strict: false }) as { skillName?: string };
  return <SkillDetailView skillName={decodeSkillNameParam(params.skillName)} />;
}
