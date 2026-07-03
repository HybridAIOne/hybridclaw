import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import {
  type AppCategory,
  type AppDetail,
  type AppKind,
  type AppSummary,
  appViewUrl,
  deleteApp,
  fetchApp,
  fetchApps,
} from '../api/apps';
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
import { ChevronDown, Search, Trash } from '../components/icons';
import { LiveAppFrame } from '../components/live-app-frame';
import { MobileTopbarTrigger } from '../components/sidebar/index';
import { useToast } from '../components/toast';
import { buildAppSeed, buildLiveAppSeed } from '../lib/app-seed';
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
  const [confirmDelete, setConfirmDelete] = useState<AppSummary | null>(null);

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

  function refreshApp(app: AppSummary) {
    if (!app.sessionId) {
      toast.error('This app has no conversation to refresh.');
      return;
    }
    setViewer(null);
    void navigate({
      to: '/chat/$sessionId',
      params: { sessionId: app.sessionId },
      search: {
        prompt:
          'Refresh this live app with the latest data from my connectors and rebuild it as a single self-contained web app.',
        send: '1',
        app: '1',
        kind: 'live',
      },
    });
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteApp(token, id),
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      if (viewer?.id === id) setViewer(null);
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
      const result = await fetchApp(token, summary.id);
      setViewer(result.app);
    } catch (error) {
      toast.error(`Could not open app: ${getErrorMessage(error)}`);
    }
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
        token={token}
        onClose={() => setViewer(null)}
        onRefresh={viewer ? () => refreshApp(viewer) : undefined}
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
          <span>{app.visibility === 'public' ? 'Public' : 'Private'}</span>
        </div>
      </button>
      <div className={styles.cardActions}>
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

function AppViewer(props: {
  app: AppDetail | null;
  token: string;
  onClose: () => void;
  onRefresh?: () => void;
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
                onClick={props.onRefresh}
              >
                <Refresh className={styles.inlineIcon} /> Refresh
              </button>
            ) : null}
            {app ? (
              <a
                className={styles.secondaryButton}
                href={appViewUrl(app.id, props.token)}
                target="_blank"
                rel="noreferrer"
              >
                Open in new tab ↗
              </a>
            ) : null}
            <DialogClose className={styles.secondaryButton}>Close</DialogClose>
          </div>
        </div>
        {app ? (
          <LiveAppFrame
            appId={app.id}
            className={styles.viewerFrame}
            title={app.title}
            token={props.token}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
