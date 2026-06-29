import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AppCategory,
  type AppDetail,
  type AppSummary,
  appViewUrl,
  deleteApp,
  fetchApp,
  fetchApps,
  generateApp,
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
import { MobileTopbarTrigger } from '../components/sidebar/index';
import { useToast } from '../components/toast';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime } from '../lib/format';
import styles from './apps.module.css';
import { AppsChatSidebar } from './apps-chat-sidebar';
import { CategoryIcon } from './apps-icons';
import chatCss from './chat/chat-page.module.css';
import { ChatSidebarProvider } from './chat/chat-sidebar';

interface CategoryMeta {
  slug: AppCategory;
  label: string;
  hint: string;
  examples: string[];
}

const CATEGORIES: CategoryMeta[] = [
  {
    slug: 'apps',
    label: 'Apps & websites',
    hint: 'Internal tools, portals, landing pages',
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
  const searchParams = useSearch({ strict: false }) as {
    build?: string;
    prompt?: string;
    category?: string;
  };
  const deepLinkHandled = useRef(false);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | AppCategory>(
    'all',
  );
  const [newOpen, setNewOpen] = useState(false);
  const [seedPrompt, setSeedPrompt] = useState('');
  const [seedCategory, setSeedCategory] = useState<AppCategory | null>(null);
  const [viewer, setViewer] = useState<AppDetail | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AppSummary | null>(null);

  const query = useQuery({
    queryKey: ['apps', token],
    queryFn: () => fetchApps(token),
    retry: false,
  });

  const generateMutation = useMutation({
    mutationFn: (vars: { description: string; category: AppCategory }) =>
      generateApp(token, {
        description: vars.description,
        category: vars.category,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      setNewOpen(false);
      setSeedPrompt('');
      setSeedCategory(null);
      toast.success(`Built “${result.app.title}”.`);
      setViewer(result.app);
    },
    onError: (error) => {
      toast.error(`Build failed: ${getErrorMessage(error)}`);
    },
  });

  // Deep-link from the chat "/app <description>" slash command:
  // /apps?build=1&prompt=...&category=... immediately builds the app. Without
  // `build`, a `prompt` just pre-fills the builder dialog.
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const prompt = searchParams.prompt?.trim();
    if (!prompt && searchParams.build !== '1') return;
    deepLinkHandled.current = true;
    const category =
      searchParams.category &&
      CATEGORY_BY_SLUG.has(searchParams.category as AppCategory)
        ? (searchParams.category as AppCategory)
        : 'scratch';
    // Clear the params so a refresh doesn't rebuild.
    void navigate({ to: '/apps', replace: true });
    if (searchParams.build === '1' && prompt) {
      generateMutation.mutate({ description: prompt, category });
      return;
    }
    if (prompt) {
      setSeedPrompt(prompt);
      setSeedCategory(category);
      setNewOpen(true);
    }
  }, [searchParams, navigate, generateMutation]);

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
                <Button
                  onClick={() => {
                    setSeedPrompt('');
                    setSeedCategory(null);
                    setNewOpen(true);
                  }}
                >
                  + New app
                </Button>
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

              {generateMutation.isPending && !newOpen ? (
                <div className={styles.buildingBanner} role="status">
                  <span className={styles.buildingSpinner} aria-hidden="true" />
                  Building your app… this can take a moment.
                </div>
              ) : null}

              {query.isPending ? (
                <div className="empty-state">Loading apps…</div>
              ) : query.isError ? (
                <div className="empty-state">
                  Failed to load apps: {getErrorMessage(query.error)}
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  hasApps={apps.length > 0}
                  onCreate={() => setNewOpen(true)}
                />
              ) : (
                <ul className={styles.grid}>
                  {filtered.map((app) => (
                    <li key={app.id}>
                      <AppCard
                        app={app}
                        onOpen={() => openApp(app)}
                        onDelete={() => setConfirmDelete(app)}
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
        open={newOpen}
        onOpenChange={(open) => {
          if (!generateMutation.isPending) setNewOpen(open);
        }}
        seedPrompt={seedPrompt}
        seedCategory={seedCategory}
        isGenerating={generateMutation.isPending}
        onSubmit={(description, category) =>
          generateMutation.mutate({ description, category })
        }
      />

      <AppViewer app={viewer} token={token} onClose={() => setViewer(null)} />

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
}) {
  const { app } = props;
  return (
    <div className={styles.card}>
      <button type="button" className={styles.cardMain} onClick={props.onOpen}>
        <div className={styles.cardGlyph} aria-hidden="true">
          <CategoryIcon category={app.category} />
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
      <button
        type="button"
        className={styles.cardDelete}
        aria-label={`Delete ${app.title}`}
        title="Delete"
        onClick={props.onDelete}
      >
        <Trash className={styles.cardDeleteIcon} />
      </button>
    </div>
  );
}

function NewAppDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seedPrompt: string;
  seedCategory: AppCategory | null;
  isGenerating: boolean;
  onSubmit: (description: string, category: AppCategory) => void;
}) {
  const [category, setCategory] = useState<AppCategory | null>(null);
  const [description, setDescription] = useState('');

  // Reset / seed each time the dialog opens.
  useEffect(() => {
    if (!props.open) return;
    setCategory(props.seedCategory);
    setDescription(props.seedPrompt);
  }, [props.open, props.seedCategory, props.seedPrompt]);

  const activeCategory = category ? CATEGORY_BY_SLUG.get(category) : undefined;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className={styles.newDialog}>
        {category === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Create a new app</DialogTitle>
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
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                <span className={styles.dialogTitleIcon} aria-hidden="true">
                  <CategoryIcon category={category} />
                </span>
                {activeCategory?.label}
              </DialogTitle>
              <DialogDescription>
                Describe what you want. HybridClaw builds a self-contained app
                and saves it to your gallery.
              </DialogDescription>
            </DialogHeader>
            <textarea
              className={styles.promptInput}
              value={description}
              autoFocus
              disabled={props.isGenerating}
              placeholder="e.g. A client onboarding portal that tracks setup steps and shows progress"
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
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
                      disabled={props.isGenerating}
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
                disabled={props.isGenerating}
                onClick={() => setCategory(null)}
              >
                ← Back
              </button>
              <Button
                disabled={props.isGenerating || description.trim().length === 0}
                onClick={() => props.onSubmit(description.trim(), category)}
              >
                {props.isGenerating ? 'Building…' : 'Build app'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppViewer(props: {
  app: AppDetail | null;
  token: string;
  onClose: () => void;
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
          <iframe
            key={app.id}
            className={styles.viewerFrame}
            title={app.title}
            src={appViewUrl(app.id, props.token)}
            // AI-generated HTML is served from the gateway origin, so it runs in
            // an opaque sandbox origin (no allow-same-origin) and cannot reach
            // gateway cookies or APIs.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
