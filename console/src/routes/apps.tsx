import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AppCategory,
  type AppDetail,
  type AppKind,
  type AppPublication,
  type AppSummary,
  appViewUrl,
  createAppPublication,
  deleteApp,
  downloadAppTeamsManifest,
  fetchApp,
  fetchAppPublications,
  fetchApps,
  revokeAppPublication,
  updateApp,
} from '../api/apps';
import { fetchMSTeamsTabStatus } from '../api/client';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from '../components/dropdown';
import { ChevronDown, Search, Share, Trash } from '../components/icons';
import {
  LiveAppFrame,
  type LiveAppFrameHandle,
} from '../components/live-app-frame';
import { MobileTopbarTrigger } from '../components/sidebar/index';
import { useToast } from '../components/toast';
import { buildAppSeed, buildLiveAppSeed } from '../lib/app-seed';
import { createAppViewToken } from '../lib/app-view-token';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import styles from './apps.module.css';
import { AppsChatSidebar } from './apps-chat-sidebar';
import { CategoryIcon, RefreshIcon as Refresh } from './apps-icons';
import chatCss from './chat/chat-page.module.css';
import { ChatSidebarProvider } from './chat/chat-sidebar';

interface CategoryMeta {
  slug: AppCategory;
  label: string;
  hint: string;
  /** Noun phrase used to seed the build conversation; null = freeform. */
  seedNoun: string | null;
  examples: string[];
}

const CATEGORIES: CategoryMeta[] = [
  {
    slug: 'apps',
    label: 'Apps & websites',
    hint: 'Internal tools, portals, landing pages',
    seedNoun: 'web app or website',
    examples: [
      'A client onboarding portal with step-by-step progress',
      'A SaaS pricing page with a monthly/annual toggle',
      'An internal team directory with search',
    ],
  },
  {
    slug: 'documents',
    label: 'Documents & templates',
    hint: 'Proposals, reports, printable templates',
    seedNoun: 'document or template',
    examples: [
      'A consulting invoice with line items and totals',
      'A quarterly business review one-pager',
      'A statement-of-work proposal template',
    ],
  },
  {
    slug: 'games',
    label: 'Games',
    hint: 'Playable browser games',
    seedNoun: 'browser game',
    examples: [
      'A product-knowledge quiz game for new hires',
      'A typing-speed trainer',
      'A memory match game',
    ],
  },
  {
    slug: 'productivity',
    label: 'Productivity tools',
    hint: 'Calculators, trackers, dashboards',
    seedNoun: 'productivity tool',
    examples: [
      'A SaaS MRR and churn dashboard',
      'A meeting-cost calculator',
      'A project ROI calculator',
    ],
  },
  {
    slug: 'creative',
    label: 'Creative projects',
    hint: 'Brand assets, mockups, visuals',
    seedNoun: 'creative project',
    examples: [
      'A branded social media post mockup',
      'A pitch-deck cover slide',
      'A simple drawing canvas',
    ],
  },
  {
    slug: 'quiz',
    label: 'Quiz or survey',
    hint: 'Lead capture, feedback, assessments',
    seedNoun: 'quiz or survey',
    examples: [
      'A lead-qualification survey with scoring',
      'An employee eNPS survey',
      'A customer CSAT form',
    ],
  },
  {
    slug: 'scratch',
    label: 'Start from scratch',
    hint: 'Describe anything you can imagine',
    seedNoun: null,
    examples: [],
  },
];

const CATEGORY_BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

function categoryLabel(slug: string): string {
  return CATEGORY_BY_SLUG.get(slug as AppCategory)?.label ?? 'App';
}

export function AppsPage() {
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | AppCategory>(
    'all',
  );
  const [newKind, setNewKind] = useState<AppKind | null>(null);
  const [viewer, setViewer] = useState<AppDetail | null>(null);
  const [viewerToken, setViewerToken] = useState('');
  const [viewerRefreshNonce, setViewerRefreshNonce] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<AppSummary | null>(null);
  const [shareApp, setShareApp] = useState<AppSummary | AppDetail | null>(null);
  const viewerFrameRef = useRef<LiveAppFrameHandle | null>(null);

  const query = useQuery({
    queryKey: ['apps', token],
    queryFn: () => fetchApps(token),
    retry: false,
  });

  // Starting a build opens a chat conversation seeded for the chosen kind:
  // web apps are category-driven; live apps inspect the user's connectors first.
  function startWebBuild(category: AppCategory, description: string) {
    const seedNoun = CATEGORY_BY_SLUG.get(category)?.seedNoun ?? null;
    setNewKind(null);
    void navigate({
      to: '/chat',
      search: {
        prompt: buildAppSeed(seedNoun, description),
        send: '1',
        app: '1',
        kind: 'web',
        ...(category !== 'scratch' ? { category } : {}),
      },
    });
  }

  function startLiveBuild(description: string) {
    setNewKind(null);
    void navigate({
      to: '/chat',
      search: {
        prompt: buildLiveAppSeed(description),
        send: '1',
        app: '1',
        kind: 'live',
      },
    });
  }

  async function loadAppViewer(appId: string): Promise<AppDetail> {
    const [result, scopedToken] = await Promise.all([
      fetchApp(token, appId),
      createAppViewToken(token, appId),
    ]);
    setViewerToken(scopedToken);
    setViewer(result.app);
    return result.app;
  }

  async function refreshApp(app: AppSummary) {
    if (app.kind !== 'live') {
      toast.error('Only live apps can refresh connector data.');
      return;
    }
    if (viewer?.id === app.id && viewerFrameRef.current?.refreshData()) {
      return;
    }
    try {
      await loadAppViewer(app.id);
      setViewerRefreshNonce((current) => current + 1);
    } catch (error) {
      toast.error(`Could not refresh app: ${getErrorMessage(error)}`);
    }
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteApp(token, id),
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      if (viewer?.id === id) {
        setViewer(null);
        setViewerToken('');
      }
      setConfirmDelete(null);
      toast.success('App deleted.');
    },
    onError: (error) => {
      toast.error(`Delete failed: ${getErrorMessage(error)}`);
    },
  });

  const apps = query.data?.apps ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return apps.filter((app) => {
      if (categoryFilter !== 'all' && app.category !== categoryFilter) {
        return false;
      }
      if (!needle) return true;
      return (
        app.title.toLowerCase().includes(needle) ||
        (app.description ?? '').toLowerCase().includes(needle)
      );
    });
  }, [apps, search, categoryFilter]);

  async function openApp(summary: AppSummary) {
    try {
      await loadAppViewer(summary.id);
    } catch (error) {
      toast.error(`Could not open app: ${getErrorMessage(error)}`);
    }
  }

  function closeViewer() {
    setViewer(null);
    setViewerToken('');
  }

  const filterLabel =
    categoryFilter === 'all' ? 'All' : categoryLabel(categoryFilter);

  return (
    <ChatSidebarProvider>
      <div className={chatCss.chatPage}>
        <AppsChatSidebar />
        <div className={chatCss.chatMain}>
          <div className={styles.scroll}>
            <div className={styles.page}>
              <header className={styles.topbar}>
                <div className={styles.topbarLeft}>
                  <MobileTopbarTrigger className={styles.mobileTrigger} />
                  <h1 className={styles.title}>Apps</h1>
                </div>
                <Dropdown>
                  <DropdownTrigger className={styles.newAppTrigger}>
                    + New app
                    <ChevronDown aria-hidden="true" />
                  </DropdownTrigger>
                  <DropdownContent align="end">
                    <DropdownItem onSelect={() => setNewKind('web')}>
                      <span className={styles.newAppItem}>
                        <span className={styles.newAppItemTitle}>Web app</span>
                        <span className={styles.newAppItemHint}>
                          Self-contained app, document, game, or tool
                        </span>
                      </span>
                    </DropdownItem>
                    <DropdownItem onSelect={() => setNewKind('live')}>
                      <span className={styles.newAppItem}>
                        <span className={styles.newAppItemTitle}>Live app</span>
                        <span className={styles.newAppItemHint}>
                          Uses your connectors and can be refreshed
                        </span>
                      </span>
                    </DropdownItem>
                  </DropdownContent>
                </Dropdown>
              </header>

              <div className={styles.toolbar}>
                <div className={styles.searchWrap}>
                  <Search className={styles.searchIcon} aria-hidden="true" />
                  <input
                    type="search"
                    className={styles.searchInput}
                    placeholder="Search apps…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search apps"
                  />
                </div>
                <Dropdown>
                  <DropdownTrigger className={styles.filterTrigger}>
                    <span>
                      Filter: <strong>{filterLabel}</strong>
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </DropdownTrigger>
                  <DropdownContent align="end">
                    <DropdownItem
                      active={categoryFilter === 'all'}
                      onSelect={() => setCategoryFilter('all')}
                    >
                      All
                    </DropdownItem>
                    {CATEGORIES.map((category) => (
                      <DropdownItem
                        key={category.slug}
                        active={categoryFilter === category.slug}
                        onSelect={() => setCategoryFilter(category.slug)}
                      >
                        {category.label}
                      </DropdownItem>
                    ))}
                  </DropdownContent>
                </Dropdown>
              </div>

              {query.isPending ? (
                <div className="empty-state">Loading apps…</div>
              ) : query.isError ? (
                <div className="empty-state">
                  Failed to load apps: {getErrorMessage(query.error)}
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  hasApps={apps.length > 0}
                  onCreate={() => setNewKind('web')}
                />
              ) : (
                <ul className={styles.grid}>
                  {filtered.map((app) => (
                    <li key={app.id}>
                      <AppCard
                        app={app}
                        onOpen={() => openApp(app)}
                        onShare={() => setShareApp(app)}
                        onDelete={() => setConfirmDelete(app)}
                        onRefresh={() => refreshApp(app)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      <NewAppDialog
        kind={newKind}
        onClose={() => setNewKind(null)}
        onStartWeb={startWebBuild}
        onStartLive={startLiveBuild}
      />

      <AppViewer
        app={viewer}
        token={viewerToken}
        onClose={closeViewer}
        frameRef={viewerFrameRef}
        refreshNonce={viewerRefreshNonce}
        onRefresh={viewer ? () => refreshApp(viewer) : undefined}
        onShare={viewer ? () => setShareApp(viewer) : undefined}
      />

      <ShareAppDialog
        app={shareApp}
        token={token}
        onClose={() => setShareApp(null)}
        onChanged={async () => {
          await queryClient.invalidateQueries({ queryKey: ['apps'] });
          if (viewer) {
            const result = await fetchApp(token, viewer.id);
            setViewer(result.app);
          }
        }}
      />

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Delete app?</DialogTitle>
            <DialogDescription>
              “{confirmDelete?.title}” will be permanently removed from the
              gallery.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className={styles.secondaryButton}>Cancel</DialogClose>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() =>
                confirmDelete && deleteMutation.mutate(confirmDelete.id)
              }
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ChatSidebarProvider>
  );
}

function EmptyState(props: { hasApps: boolean; onCreate: () => void }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyGlyph} aria-hidden="true">
        <CategoryIcon category="scratch" />
      </div>
      <h2 className={styles.emptyTitle}>
        {props.hasApps ? 'No matching apps' : 'No apps yet'}
      </h2>
      <p className={styles.emptyText}>
        {props.hasApps
          ? 'Try a different search or filter.'
          : 'Describe an app, document, tool, or report and HybridClaw builds it for you.'}
      </p>
      {!props.hasApps ? (
        <Button onClick={props.onCreate}>+ New app</Button>
      ) : null}
    </div>
  );
}

function AppCard(props: {
  app: AppSummary;
  onOpen: () => void;
  onShare: () => void;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  const { app } = props;
  const isLive = app.kind === 'live';
  return (
    <div className={styles.card}>
      <button type="button" className={styles.cardMain} onClick={props.onOpen}>
        <div className={styles.cardTop}>
          <div className={styles.cardGlyph} aria-hidden="true">
            <CategoryIcon category={app.category} />
          </div>
          <span
            className={isLive ? styles.kindBadgeLive : styles.kindBadge}
            title={isLive ? 'Connector-aware, refreshable' : undefined}
          >
            {isLive ? 'Live' : 'Web'}
          </span>
        </div>
        <div className={styles.cardBody}>
          <span className={styles.cardTitle}>{app.title}</span>
          {app.description ? (
            <span className={styles.cardDesc}>{app.description}</span>
          ) : null}
        </div>
        <div className={styles.cardMeta}>
          <span className={styles.cardCategory}>
            {categoryLabel(app.category)}
          </span>
          <span className={styles.cardDot}>·</span>
          <span>{formatRelativeTime(app.createdAt)}</span>
          <span className={styles.cardDot}>·</span>
          <span>{app.visibility === 'public' ? 'Shared' : 'Not shared'}</span>
        </div>
      </button>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.cardAction}
          aria-label={`Share ${app.title}`}
          title="Share"
          onClick={props.onShare}
        >
          <Share className={styles.cardActionIcon} />
        </button>
        {isLive ? (
          <button
            type="button"
            className={styles.cardAction}
            aria-label={`Refresh ${app.title}`}
            title="Refresh with latest data"
            onClick={props.onRefresh}
          >
            <Refresh className={styles.cardActionIcon} />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.cardAction}
          aria-label={`Delete ${app.title}`}
          title="Delete"
          onClick={props.onDelete}
        >
          <Trash className={styles.cardActionIcon} />
        </button>
      </div>
    </div>
  );
}

function NewAppDialog(props: {
  kind: AppKind | null;
  onClose: () => void;
  onStartWeb: (category: AppCategory, description: string) => void;
  onStartLive: (description: string) => void;
}) {
  const [category, setCategory] = useState<AppCategory | null>(null);
  const [description, setDescription] = useState('');
  const open = props.kind !== null;

  // Reset each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open/kind change
  useEffect(() => {
    if (!open) return;
    setCategory(null);
    setDescription('');
  }, [open, props.kind]);

  const activeCategory = category ? CATEGORY_BY_SLUG.get(category) : undefined;
  const showCategoryGrid = props.kind === 'web' && category === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent className={styles.newDialog}>
        {showCategoryGrid ? (
          <>
            <DialogHeader>
              <DialogTitle>Create a web app</DialogTitle>
              <DialogDescription>
                Pick a category to get started, or start from scratch with your
                own idea.
              </DialogDescription>
            </DialogHeader>
            <div className={styles.categoryGrid}>
              {CATEGORIES.map((meta) => (
                <button
                  key={meta.slug}
                  type="button"
                  className={styles.categoryTile}
                  onClick={() => setCategory(meta.slug)}
                >
                  <span className={styles.categoryGlyph} aria-hidden="true">
                    <CategoryIcon category={meta.slug} />
                  </span>
                  <span className={styles.categoryLabel}>{meta.label}</span>
                  <span className={styles.categoryHint}>{meta.hint}</span>
                </button>
              ))}
            </div>
          </>
        ) : props.kind === 'live' ? (
          <>
            <DialogHeader>
              <DialogTitle>Create a live app</DialogTitle>
              <DialogDescription>
                HybridClaw checks your connected tools (MCP), suggests apps that
                use them, then builds one you can refresh. Add a starting idea
                (optional).
              </DialogDescription>
            </DialogHeader>
            <textarea
              className={styles.promptInput}
              value={description}
              autoFocus
              placeholder="e.g. A dashboard of my upcoming meetings and unread priority emails"
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
            <DialogFooter>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={props.onClose}
              >
                Cancel
              </button>
              <Button onClick={() => props.onStartLive(description.trim())}>
                Start building →
              </Button>
            </DialogFooter>
          </>
        ) : category ? (
          <>
            <DialogHeader>
              <DialogTitle>
                <span className={styles.dialogTitleIcon} aria-hidden="true">
                  <CategoryIcon category={category} />
                </span>
                {activeCategory?.label}
              </DialogTitle>
              <DialogDescription>
                Add a starting idea (optional). HybridClaw opens a chat, asks a
                few questions, then builds it for you.
              </DialogDescription>
            </DialogHeader>
            <textarea
              className={styles.promptInput}
              value={description}
              autoFocus
              placeholder="e.g. A client onboarding portal that tracks setup steps and shows progress"
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
            {activeCategory && activeCategory.examples.length > 0 ? (
              <div className={styles.examples}>
                <span className={styles.examplesLabel}>Examples</span>
                <div className={styles.exampleChips}>
                  {activeCategory.examples.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className={styles.exampleChip}
                      onClick={() => setDescription(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setCategory(null)}
              >
                ← Back
              </button>
              <Button
                onClick={() => props.onStartWeb(category, description.trim())}
              >
                Start building →
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function splitShareList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function ShareAppDialog(props: {
  app: AppSummary | AppDetail | null;
  token: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const app = props.app;
  const [mode, setMode] = useState<'link' | 'company' | 'teams' | 'password'>(
    'link',
  );
  const [password, setPassword] = useState('');
  const [shareLiveData, setShareLiveData] = useState(false);
  const [embedHosts, setEmbedHosts] = useState('');
  const [allowFrom, setAllowFrom] = useState('');
  const [expiresAfterDays, setExpiresAfterDays] = useState('');
  const [sessionMinutes, setSessionMinutes] = useState('');
  const [createdUrl, setCreatedUrl] = useState('');
  const [downloadingManifest, setDownloadingManifest] = useState(false);
  const open = app !== null;

  const publicationsQuery = useQuery({
    queryKey: ['app-publications', props.token, app?.id],
    enabled: open && Boolean(app),
    queryFn: () => fetchAppPublications(props.token, app?.id || ''),
    retry: false,
  });

  const teamsStatusQuery = useQuery({
    queryKey: ['msteams-tab-status', props.token],
    enabled: open && mode === 'teams',
    queryFn: () => fetchMSTeamsTabStatus(props.token),
    retry: false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when a different app is selected while the dialog is open
  useEffect(() => {
    if (!open) return;
    setMode('link');
    setPassword('');
    setShareLiveData(false);
    setEmbedHosts('');
    setAllowFrom('');
    setExpiresAfterDays('');
    setSessionMinutes('');
    setCreatedUrl('');
    setDownloadingManifest(false);
  }, [open, app?.id]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!app) throw new Error('No app selected.');
      const expiryDays = parsePositiveNumber(expiresAfterDays, 'Link expiry');
      const ttlMinutes = parsePositiveNumber(sessionMinutes, 'Session length');
      return createAppPublication(props.token, app.id, {
        kind: mode,
        ...(mode === 'password' ? { password } : {}),
        embedHosts: splitShareList(embedHosts),
        ...(mode === 'company' || mode === 'teams'
          ? { allowFrom: splitShareList(allowFrom) }
          : {}),
        ...(ttlMinutes ? { ttlSeconds: Math.round(ttlMinutes * 60) } : {}),
        ...(expiryDays
          ? {
              expiresAt: new Date(
                Date.now() + expiryDays * 24 * 60 * 60 * 1000,
              ).toISOString(),
            }
          : {}),
        allowBridge: app.kind === 'live' && shareLiveData,
        acknowledgeAnonymousBridge:
          app.kind === 'live' &&
          shareLiveData &&
          (mode === 'link' || mode === 'password'),
      });
    },
    onSuccess: async (result) => {
      setCreatedUrl(result.url);
      toast.success(
        mode === 'teams' ? 'Teams sharing enabled.' : 'Sharing link created.',
      );
      await publicationsQuery.refetch();
      await props.onChanged();
    },
    onError: (error) => {
      toast.error(`Share failed: ${getErrorMessage(error)}`);
    },
  });

  const stopSharingMutation = useMutation({
    mutationFn: async () => {
      if (!app) throw new Error('No app selected.');
      return updateApp(props.token, app.id, { visibility: 'private' });
    },
    onSuccess: async () => {
      setCreatedUrl('');
      toast.success('Sharing stopped.');
      await publicationsQuery.refetch();
      await props.onChanged();
    },
    onError: (error) => {
      toast.error(`Stop sharing failed: ${getErrorMessage(error)}`);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (publication: AppPublication) => {
      if (!app) throw new Error('No app selected.');
      return revokeAppPublication(props.token, app.id, publication.id);
    },
    onSuccess: async () => {
      toast.success('Sharing link revoked.');
      await publicationsQuery.refetch();
      await props.onChanged();
    },
    onError: (error) => {
      toast.error(`Revoke failed: ${getErrorMessage(error)}`);
    },
  });

  async function copyUrl() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      toast.success(mode === 'teams' ? 'Teams link copied.' : 'Link copied.');
    } catch {
      toast.error('Could not copy link.');
    }
  }

  function openTeams() {
    const status = teamsStatusQuery.data;
    if (!status || !app) {
      window.open(createdUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const context = encodeURIComponent(
      JSON.stringify({ subEntityId: app.id, contentUrl: createdUrl }),
    );
    window.open(
      `https://teams.microsoft.com/l/entity/${encodeURIComponent(
        status.orgAppId,
      )}/${encodeURIComponent(status.orgAppEntityId)}?context=${context}`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  async function downloadTeamsManifest() {
    if (!app || downloadingManifest) return;
    setDownloadingManifest(true);
    try {
      const blob = await downloadAppTeamsManifest(props.token, app.id);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `hybridclaw-${app.id}-teams.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      toast.error(`Download failed: ${getErrorMessage(error)}`);
    } finally {
      setDownloadingManifest(false);
    }
  }

  const publications = publicationsQuery.data?.publications ?? [];
  const activePublications = publications.filter(
    (publication) => !publication.revokedAt,
  );
  const teamsStatus = teamsStatusQuery.data;
  const teamsSetupReady = Boolean(
    teamsStatus?.enabled &&
      teamsStatus.tenantId &&
      teamsStatus.ssoAppId &&
      teamsStatus.appIdUri &&
      teamsStatus.publicOrigin,
  );
  const canCreate =
    !createMutation.isPending &&
    (mode === 'link' ||
      mode === 'company' ||
      mode === 'teams' ||
      password.trim().length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent className={styles.shareDialog}>
        <DialogHeader>
          <DialogTitle>Share {app?.title}</DialogTitle>
          <DialogDescription>
            Choose who can open this app outside the console.
          </DialogDescription>
        </DialogHeader>

        <div className={styles.shareModes}>
          <button
            type="button"
            className={
              mode === 'link' ? styles.shareModeActive : styles.shareMode
            }
            onClick={() => setMode('link')}
          >
            Anyone with the link
          </button>
          <button
            type="button"
            className={
              mode === 'company' ? styles.shareModeActive : styles.shareMode
            }
            onClick={() => setMode('company')}
          >
            Anyone in my company
          </button>
          <button
            type="button"
            className={
              mode === 'teams' ? styles.shareModeActive : styles.shareMode
            }
            onClick={() => setMode('teams')}
          >
            Add to Teams
          </button>
          <button
            type="button"
            className={
              mode === 'password' ? styles.shareModeActive : styles.shareMode
            }
            onClick={() => setMode('password')}
          >
            Password
          </button>
        </div>

        {mode === 'teams' ? (
          <div className={styles.teamsSetupNotice}>
            <strong>Set up the Teams app in Channels first.</strong>
            <p>
              Add to Teams uses the org Teams app. Open Channels, Microsoft
              Teams, App Setup, finish the Entra SSO setup, and upload the org
              app package before sharing individual apps here.
            </p>
            <div className={styles.teamsSetupNoticeFooter}>
              <a href="/admin/channels">Open Microsoft Teams settings</a>
              {teamsStatusQuery.isFetching ? (
                <span>Checking Teams setup…</span>
              ) : teamsStatusQuery.isError ? (
                <span>Setup status unavailable.</span>
              ) : teamsStatus ? (
                <span>
                  Teams app setup: {teamsSetupReady ? 'ready' : 'incomplete'}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {mode === 'password' ? (
          <label className={styles.shareField}>
            <span>Password</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        ) : null}

        {app?.kind === 'live' ? (
          <div className={styles.exposureBox}>
            <p>
              This app pulls live data from your connected tools.
              {mode === 'link' || mode === 'password'
                ? ' Anyone with this link would see that data whenever they open it.'
                : ' Shared viewers would see that data whenever they open it.'}
            </p>
            <div className={styles.exposureActions}>
              <button
                type="button"
                className={
                  !shareLiveData ? styles.shareModeActive : styles.shareMode
                }
                onClick={() => setShareLiveData(false)}
              >
                Share a static snapshot
              </button>
              <button
                type="button"
                className={
                  shareLiveData ? styles.shareModeActive : styles.shareMode
                }
                onClick={() => setShareLiveData(true)}
              >
                Share live data anyway
              </button>
            </div>
          </div>
        ) : null}

        {createdUrl ? (
          <div className={styles.shareResult}>
            <input
              readOnly
              value={createdUrl}
              aria-label={mode === 'teams' ? 'Teams link' : 'Sharing link'}
            />
            {mode === 'teams' ? (
              <Button onClick={openTeams}>Open in Teams</Button>
            ) : (
              <Button onClick={copyUrl}>Copy link</Button>
            )}
          </div>
        ) : null}

        <details className={styles.advancedShare}>
          <summary>More options</summary>
          <div className={styles.advancedSharePanel}>
            <label className={styles.shareField}>
              <span>Embed on websites</span>
              <textarea
                className={styles.shareTextarea}
                value={embedHosts}
                placeholder="https://dashboard.example.com"
                rows={2}
                onChange={(event) => setEmbedHosts(event.target.value)}
              />
            </label>
            {mode === 'company' || mode === 'teams' ? (
              <label className={styles.shareField}>
                <span>Limit to people</span>
                <textarea
                  className={styles.shareTextarea}
                  value={allowFrom}
                  placeholder="person@example.com"
                  rows={2}
                  onChange={(event) => setAllowFrom(event.target.value)}
                />
              </label>
            ) : null}
            <div className={styles.advancedShareGrid}>
              <label className={styles.shareField}>
                <span>Link expires after</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={expiresAfterDays}
                  placeholder="Days"
                  onChange={(event) => setExpiresAfterDays(event.target.value)}
                />
              </label>
              <label className={styles.shareField}>
                <span>Viewer session length</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={sessionMinutes}
                  placeholder="Minutes"
                  onChange={(event) => setSessionMinutes(event.target.value)}
                />
              </label>
            </div>
            {mode === 'teams' ? (
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={!app || downloadingManifest}
                onClick={downloadTeamsManifest}
              >
                {downloadingManifest
                  ? 'Downloading…'
                  : 'Download standalone Teams app'}
              </button>
            ) : null}
          </div>
        </details>

        {activePublications.length > 0 ? (
          <div className={styles.publicationList}>
            <span className={styles.publicationListTitle}>Shared links</span>
            {activePublications.map((publication) => (
              <div key={publication.id} className={styles.publicationRow}>
                <span>{publicationAudienceLabel(publication)}</span>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(publication)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <DialogFooter>
          {app?.visibility === 'public' || activePublications.length > 0 ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={stopSharingMutation.isPending}
              onClick={() => stopSharingMutation.mutate()}
            >
              {stopSharingMutation.isPending ? 'Stopping…' : 'Stop sharing'}
            </button>
          ) : null}
          <DialogClose className={styles.secondaryButton}>Close</DialogClose>
          <Button disabled={!canCreate} onClick={() => createMutation.mutate()}>
            {createMutation.isPending
              ? 'Creating…'
              : mode === 'teams'
                ? 'Add to Teams'
                : 'Share'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function publicationAudienceLabel(publication: AppPublication): string {
  if (publication.policy.kind === 'password') return 'Password-protected link';
  if (publication.policy.kind === 'oidc') {
    return publication.embedHosts.some((host) => host.includes('teams'))
      ? 'In Teams'
      : 'Anyone in my company';
  }
  return 'Anyone with the link';
}

function AppViewer(props: {
  app: AppDetail | null;
  token: string;
  onClose: () => void;
  frameRef: RefObject<LiveAppFrameHandle | null>;
  refreshNonce: number;
  onRefresh?: () => void;
  onShare?: () => void;
}) {
  const { app } = props;
  return (
    <Dialog
      open={app !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className={styles.viewerDialog} aria-label="App preview">
        <div className={styles.viewerHeader}>
          <DialogTitle className={styles.viewerTitle}>{app?.title}</DialogTitle>
          <div className={styles.viewerActions}>
            {app && app.kind === 'live' && props.onRefresh ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRefresh?.();
                }}
              >
                <Refresh className={styles.inlineIcon} /> Refresh
              </button>
            ) : null}
            {app && props.onShare ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onShare?.();
                }}
              >
                <Share className={styles.inlineIcon} /> Share
              </button>
            ) : null}
            {app && props.token ? (
              <a
                className={styles.secondaryButton}
                href={appViewUrl(app.id, props.token)}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                Open in new tab ↗
              </a>
            ) : null}
            <DialogClose
              className={styles.secondaryButton}
              onClick={(event) => event.stopPropagation()}
            >
              Close
            </DialogClose>
          </div>
        </div>
        {app && props.token ? (
          <LiveAppFrame
            ref={props.frameRef}
            appId={app.id}
            className={styles.viewerFrame}
            refreshNonce={props.refreshNonce}
            title={app.title}
            token={props.token}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
